import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { extractDroppedUrl, installDropLink, INTERNAL_TYPE, routeDroppedUrl, type DropData } from "../src/lib/dropLink";
import { DropLink, NOTE_MS } from "../src/components/DropLink";
import { setNavigator } from "../src/lib/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeDt = DropData & { types: string[]; dropEffect: string; setData(f: string, v: string): void };
// A DataTransfer stand-in: `types` plus getData for the formats given.
function dt(data: Record<string, string>, extraTypes: string[] = []): FakeDt {
  const d = { ...data };
  const o: FakeDt = {
    types: [...Object.keys(d), ...extraTypes],
    getData: (f) => d[f] ?? "",
    setData: (f, v) => { d[f] = v; if (!o.types.includes(f)) o.types.push(f); },
    dropEffect: "none",
  };
  return o;
}

const fakeCore = (artists: { url: string }[] = []) => ({
  import: vi.fn(async (_req: { url: string }) => ({ id: 1 })),
  artists: vi.fn(async () => artists),
});
const useCore = (c: ReturnType<typeof fakeCore>) => { (globalThis as { __fakeCore?: unknown }).__fakeCore = c; };

describe("extractDroppedUrl", () => {
  it("reads the first URL of a uri-list, skipping comments and blank lines", () => {
    const list = "# dragged from Safari\r\n\r\nhttps://artist.bandcamp.com/album/one\r\nhttps://artist.bandcamp.com/album/two\r\n";
    expect(extractDroppedUrl(dt({ "text/uri-list": list }))).toBe("https://artist.bandcamp.com/album/one");
  });

  it("falls back to plain text with whitespace around the URL", () => {
    expect(extractDroppedUrl(dt({ "text/plain": "  \n\thttps://artist.bandcamp.com/track/x \n" }))).toBe("https://artist.bandcamp.com/track/x");
  });

  it("takes the first http(s) URL out of several in plain text, ignoring other words and schemes", () => {
    const text = "see ftp://example.com/a and <https://a.bandcamp.com/album/b> then https://c.bandcamp.com";
    expect(extractDroppedUrl(dt({ "text/plain": text }))).toBe("https://a.bandcamp.com/album/b");
  });

  it("prefers the uri-list over plain text (Chrome sends the link title as text)", () => {
    expect(extractDroppedUrl(dt({ "text/plain": "Some Album | Artist", "text/uri-list": "https://a.bandcamp.com/album/b" }))).toBe("https://a.bandcamp.com/album/b");
  });

  it("returns the URL of a non-Bandcamp link too (routing decides)", () => {
    expect(extractDroppedUrl(dt({ "text/uri-list": "https://example.com/page" }))).toBe("https://example.com/page");
  });

  it("returns null for files only, file URLs, text without a URL, or a getData that throws", () => {
    expect(extractDroppedUrl(dt({}, ["Files"]))).toBeNull();
    expect(extractDroppedUrl(dt({ "text/uri-list": "file:///Users/me/a.webloc" }, ["Files"]))).toBeNull();
    expect(extractDroppedUrl(dt({ "text/plain": "just some words" }))).toBeNull();
    expect(extractDroppedUrl({ types: ["text/uri-list"], getData: () => { throw new Error("protected"); } })).toBeNull();
  });
});

describe("routeDroppedUrl", () => {
  const nav = vi.fn();
  let core = fakeCore();
  beforeEach(() => {
    nav.mockReset();
    core = fakeCore([{ url: "https://music.known-artist.com" }]);
    useCore(core);
    setNavigator(nav);
  });
  afterEach(() => setNavigator(null));

  it("starts an import job for an album and shows the Import page", async () => {
    const r = await routeDroppedUrl("https://artist.bandcamp.com/album/one/?from=search#x");
    expect(r).toEqual({ kind: "import", url: "https://artist.bandcamp.com/album/one" });
    expect(core.import).toHaveBeenCalledWith({ url: "https://artist.bandcamp.com/album/one" });
    expect(nav).toHaveBeenCalledWith("/import");
  });

  it("imports a track on a custom domain", async () => {
    const r = await routeDroppedUrl("https://music.example.org/track/song");
    expect(r).toEqual({ kind: "import", url: "https://music.example.org/track/song" });
    expect(core.import).toHaveBeenCalledWith({ url: "https://music.example.org/track/song" });
  });

  it("opens Browse for a bandcamp.com artist or label page instead of importing", async () => {
    const r = await routeDroppedUrl("https://label.bandcamp.com/");
    expect(r).toEqual({ kind: "browse", url: "https://label.bandcamp.com/music" });
    expect(nav).toHaveBeenCalledWith(`/browse?url=${encodeURIComponent("https://label.bandcamp.com/music")}`);
    expect(core.import).not.toHaveBeenCalled();
  });

  it("opens Browse for a custom domain only with /music or /releases, or a host in the library", async () => {
    expect(await routeDroppedUrl("https://music.example.org/music/")).toEqual({ kind: "browse", url: "https://music.example.org/music" });
    expect(await routeDroppedUrl("https://music.example.org/releases")).toEqual({ kind: "browse", url: "https://music.example.org/music" });
    expect(await routeDroppedUrl("https://music.known-artist.com/")).toEqual({ kind: "browse", url: "https://music.known-artist.com/music" });
  });

  it("rejects a bare non-Bandcamp homepage instead of browsing it", async () => {
    for (const u of ["https://github.com/", "https://news.ycombinator.com"]) {
      expect(await routeDroppedUrl(u)).toEqual({ kind: "rejected", message: "Not a Bandcamp link" });
    }
    expect(nav).not.toHaveBeenCalled();
  });

  it("rejects non-Bandcamp links and missing URLs without touching the job runner", async () => {
    for (const u of ["https://bandcamp.com/discover", "https://example.com/some/page", "http://localhost:5173/album/1", null]) {
      expect(await routeDroppedUrl(u)).toEqual({ kind: "rejected", message: "Not a Bandcamp link" });
    }
    expect(core.import).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it("reports a failed enqueue as a note and stays put", async () => {
    core.import.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "challenge_cooldown", detail: { until: Date.now() + 60_000 } }));
    const r = await routeDroppedUrl("https://a.bandcamp.com/album/b");
    expect(r.kind).toBe("rejected");
    expect(nav).not.toHaveBeenCalled();
  });
});

const fire = (type: string, data?: FakeDt, target: EventTarget = window) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
  Object.defineProperty(e, "dataTransfer", { value: data ?? null });
  target.dispatchEvent(e);
  return e;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("installDropLink", () => {
  const nav = vi.fn();
  let core = fakeCore();
  const onActive = vi.fn();
  const onNote = vi.fn();
  let off: () => void;
  beforeEach(() => {
    nav.mockReset(); onActive.mockReset(); onNote.mockReset();
    core = fakeCore(); useCore(core);
    setNavigator(nav);
    off = installDropLink(window, { onActive, onNote });
  });
  afterEach(() => { off(); setNavigator(null); document.body.innerHTML = ""; });

  it("outlines a link drag, takes the drop over and imports", async () => {
    const data = dt({ "text/uri-list": "https://a.bandcamp.com/album/b" });
    expect(fire("dragenter", data).defaultPrevented).toBe(true);
    expect(onActive).toHaveBeenLastCalledWith(true);
    expect(fire("dragover", data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("copy");
    expect(fire("drop", data).defaultPrevented).toBe(true);
    expect(onActive).toHaveBeenLastCalledWith(false);
    await flush();
    expect(core.import).toHaveBeenCalledWith({ url: "https://a.bandcamp.com/album/b" });
    expect(onNote).not.toHaveBeenCalled();
  });

  it("notes a non-Bandcamp link", async () => {
    fire("drop", dt({ "text/plain": "https://example.com/x" }));
    await flush();
    expect(onNote).toHaveBeenCalledWith("Not a Bandcamp link");
    expect(core.import).not.toHaveBeenCalled();
  });

  it("swallows a file drop silently: no outline, no note, no import", async () => {
    for (const files of [dt({}, ["Files"]), dt({ "text/uri-list": "file:///Users/me/song.mp3" }, ["Files"])]) {
      fire("dragenter", files);
      expect(fire("dragover", files).defaultPrevented).toBe(true); // WebKit must not open the file itself
      expect(files.dropEffect).toBe("none");
      expect(fire("drop", files).defaultPrevented).toBe(true);
    }
    await flush();
    expect(onActive).not.toHaveBeenCalledWith(true);
    expect(onNote).not.toHaveBeenCalled();
    expect(core.import).not.toHaveBeenCalled();
  });

  it("marks drags that start in the page and leaves them to their targets (queue rows)", async () => {
    const data = dt({});
    fire("dragstart", data);
    expect(data.types).toContain(INTERNAL_TYPE);
    data.setData("text/uri-list", "https://a.bandcamp.com/album/b");
    expect(fire("dragenter", data).defaultPrevented).toBe(false);
    expect(fire("dragover", data).defaultPrevented).toBe(false);
    expect(fire("drop", data).defaultPrevented).toBe(false);
    await flush();
    expect(core.import).not.toHaveBeenCalled();
    expect(onActive).not.toHaveBeenCalledWith(true);
  });

  it("has no state an unfinished in-page drag can leave behind", async () => {
    fire("dragstart", dt({})); // its dragend never reaches the window (the row was removed)
    const file = dt({}, ["Files"]);
    expect(fire("dragover", file).defaultPrevented).toBe(true);
    expect(fire("drop", file).defaultPrevented).toBe(true);
    fire("drop", dt({ "text/uri-list": "https://a.bandcamp.com/album/b" }));
    await flush();
    expect(core.import).toHaveBeenCalledTimes(1);
  });

  it("leaves an in-page drag that carries files (album art) to the page, not the file rule", async () => {
    const art = dt({ [INTERNAL_TYPE]: "1", "text/uri-list": "https://f4.bcbits.com/img/a1_10.jpg" }, ["Files"]);
    expect(fire("dragenter", art).defaultPrevented).toBe(false);
    expect(fire("dragover", art).defaultPrevented).toBe(false);
    expect(fire("drop", art).defaultPrevented).toBe(false);
    await flush();
    expect(onActive).not.toHaveBeenCalledWith(true);
    expect(onNote).not.toHaveBeenCalled();
    expect(core.import).not.toHaveBeenCalled();
  });

  it("leaves plain text dropped on a text field to WebKit, but still takes a link there", async () => {
    const area = document.createElement("textarea");
    document.body.append(area);
    const text = dt({ "text/plain": "liner notes from elsewhere" });
    expect(fire("dragover", text, area).defaultPrevented).toBe(false);
    expect(fire("drop", text, area).defaultPrevented).toBe(false);
    const link = dt({ "text/uri-list": "https://a.bandcamp.com/album/b" });
    expect(fire("drop", link, area).defaultPrevented).toBe(true);
    await flush();
    expect(onNote).not.toHaveBeenCalled();
    expect(core.import).toHaveBeenCalledTimes(1);
  });

  it("keeps the outline across child enter/leave pairs until the drag leaves the window", () => {
    const data = dt({ "text/uri-list": "https://a.bandcamp.com/album/b" });
    fire("dragenter", data); fire("dragenter", data); fire("dragleave", data);
    expect(onActive).not.toHaveBeenCalledWith(false);
    fire("dragleave", data);
    expect(onActive).toHaveBeenLastCalledWith(false);
  });
});

describe("DropLink note", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    useCore(fakeCore());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(h(DropLink)));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

  const dropBad = async () => {
    await act(async () => { fire("drop", dt({ "text/plain": "https://example.com/x" })); await vi.advanceTimersByTimeAsync(0); });
  };
  const note = () => host.querySelector(".drop-note")?.textContent ?? null;

  it("restarts the timer when the same message repeats", async () => {
    await dropBad();
    expect(note()).toBe("Not a Bandcamp link");
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTE_MS - 500); });
    await dropBad();
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTE_MS - 500); });
    expect(note()).toBe("Not a Bandcamp link");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(note()).toBeNull();
  });
});
