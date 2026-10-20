import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { deleteAlbum } from "../src/db/repos/albums.js";
import { clearResumePosition, getResumePosition, setResumePosition } from "../src/db/repos/resumePositions.js";
import { formatResumeAt, resumeEligible, resumePoint, RESUME_MAX_ROWS } from "../src/services/resume.js";
import { radioQueueTrack } from "../src/services/radio.js";
import { exportLibrary } from "../src/services/libraryTransfer.js";

describe("resume rules (#85)", () => {
  it("long tracks and radio episodes resume; shorter tracks don't", () => {
    expect(resumeEligible({ id: 1, duration: 20 * 60 })).toBe(false);
    expect(resumeEligible({ id: 1, duration: 20 * 60 + 1 })).toBe(true);
    expect(resumeEligible({ id: 1, duration: null })).toBe(false);
    // The element's duration wins over the queue entry's.
    expect(resumeEligible({ id: 1, duration: 300 }, 3600)).toBe(true);
    expect(resumeEligible({ id: 1, duration: 3600 }, NaN)).toBe(true);
    expect(resumeEligible(radioQueueTrack({ id: 1008, title: "x", program: "p", image_id: null, url: "u" }))).toBe(true);
    expect(resumeEligible(null)).toBe(false);
  });

  it("drops points in the first or the last 30 s", () => {
    expect(resumePoint(29.9, 3600)).toBeNull();
    expect(resumePoint(30, 3600)).toBe(30);
    expect(resumePoint(3570, 3600)).toBeNull();
    expect(resumePoint(3569, 3600)).toBe(3569);
    expect(resumePoint(2000, NaN)).toBe(2000); // duration unknown: only the start rule applies
    expect(resumePoint(NaN, 3600)).toBeNull();
  });

  it("formats the hint's time", () => {
    expect(formatResumeAt(2480)).toBe("41:20");
    expect(formatResumeAt(65.9)).toBe("1:05");
    expect(formatResumeAt(3725)).toBe("1:02:05");
  });
});

describe("resume_positions repo (#85)", () => {
  let db: NodeDb;
  beforeEach(() => { db = new NodeDb(); });

  it("saves, updates, reads and clears a point; negative ids are radio shows", async () => {
    expect(await getResumePosition(db, 5)).toBeNull();
    await setResumePosition(db, 5, 100.5);
    await setResumePosition(db, 5, 2480);
    await setResumePosition(db, -1008, 1900);
    expect(await getResumePosition(db, 5)).toBe(2480);
    expect(await getResumePosition(db, -1008)).toBe(1900);
    await clearResumePosition(db, 5);
    await clearResumePosition(db, 5); // idempotent
    expect(await getResumePosition(db, 5)).toBeNull();
    expect(await getResumePosition(db, -1008)).toBe(1900);
  });

  it("ignores a position that is not a finite non-negative number", async () => {
    await setResumePosition(db, 1, NaN);
    await setResumePosition(db, 1, -3);
    expect(await getResumePosition(db, 1)).toBeNull();
  });

  it(`keeps the ${RESUME_MAX_ROWS} most recently saved, the oldest go`, async () => {
    for (let i = 1; i <= RESUME_MAX_ROWS + 5; i++) await setResumePosition(db, i, 60, 1000 + i);
    const n = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM resume_positions");
    expect(n?.n).toBe(RESUME_MAX_ROWS);
    for (let i = 1; i <= 5; i++) expect(await getResumePosition(db, i)).toBeNull();
    expect(await getResumePosition(db, 6)).toBe(60);
    // Saving an old row again makes it the newest: the next oldest goes instead.
    await setResumePosition(db, 6, 90, 5000);
    await setResumePosition(db, 9999, 60, 5001);
    expect(await getResumePosition(db, 6)).toBe(90);
    expect(await getResumePosition(db, 7)).toBeNull();
  });

  it("a deleted track's point goes with vacuumOrphans; radio points stay", async () => {
    const albumId = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
    const [t] = await db.select<{ id: number }>("SELECT id FROM tracks WHERE album_id = ? ORDER BY id", [albumId]);
    await setResumePosition(db, t.id, 1500);
    await setResumePosition(db, -1008, 1900);
    await vacuumOrphans(db);
    expect(await getResumePosition(db, t.id)).toBe(1500);
    await deleteAlbum(db, albumId);
    await vacuumOrphans(db);
    expect(await getResumePosition(db, t.id)).toBeNull();
    expect(await getResumePosition(db, -1008)).toBe(1900);
  });

  it("is not part of the library export (personal playback state, like play_state)", async () => {
    const albumId = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
    const [t] = await db.select<{ id: number }>("SELECT id FROM tracks WHERE album_id = ? ORDER BY id", [albumId]);
    await setResumePosition(db, t.id, 1500);
    const text = JSON.stringify(await exportLibrary(db, { history: true }));
    expect(text).not.toMatch(/resume/i);
  });
});
