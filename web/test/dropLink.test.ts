import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDroppedUrl, installDropLink, routeDroppedUrl, type DropData } from "../src/lib/dropLink";
import { setNavigator } from "../src/lib/navigation";

// A DataTransfer stand-in: `types` plus getData for the formats given.
function dt(data: Record<string, string>, extraTypes: string[] = []): DropData & { dropEffect: string; files: unknown[] } {
  return { types: [...Object.keys(data), ...extraTypes], getData: (f) => data[f] ?? "", dropEffect: "none", files: [] };
}

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

  it("returns null for files only, text without a URL, or a getData that throws", () => {
    expect(extractDroppedUrl(dt({}, ["Files"]))).toBeNull();
    expect(extractDroppedUrl(dt({ "text/plain": "just some words" }))).toBeNull();
    expect(extractDroppedUrl({ types: ["text/uri-list"], getData: () => { throw new Error("protected"); } })).toBeNull();
  });
});

describe("routeDroppedUrl", () => {
  const nav = vi.fn();
  const core = { import: vi.fn(async (_req: { url: string }) => ({ id: 1 })) };
  beforeEach(() => {
    nav.mockReset();
    core.import.mockClear();
    (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
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

  it("opens Browse for an artist or label page instead of importing", async () => {
    const r = await routeDroppedUrl("https://label.bandcamp.com/");
    expect(r).toEqual({ kind: "browse", url: "https://label.bandcamp.com/music" });
    expect(nav).toHaveBeenCalledWith(`/browse?url=${encodeURIComponent("https://label.bandcamp.com/music")}`);
    expect(core.import).not.toHaveBeenCalled();
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

describe("installDropLink", () => {
  const nav = vi.fn();
  const core = { import: vi.fn(async () => ({ id: 1 })) };
  const onActive = vi.fn();
  const onNote = vi.fn();
  let off: () => void;
  const fire = (type: string, data?: ReturnType<typeof dt>) => {
    const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
    Object.defineProperty(e, "dataTransfer", { value: data ?? null });
    window.dispatchEvent(e);
    return e;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => {
    nav.mockReset(); core.import.mockClear(); onActive.mockReset(); onNote.mockReset();
    (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
    setNavigator(nav);
    off = installDropLink(window, { onActive, onNote });
  });
  afterEach(() => { off(); setNavigator(null); });

  it("outlines a link drag, takes the drop over and imports", async () => {
    const data = dt({ "text/uri-list": "https://a.bandcamp.com/album/b" });
    expect(fire("dragenter", data).defaultPrevented).toBe(true);
    expect(onActive).toHaveBeenLastCalledWith(true);
    const over = fire("dragover", data);
    expect(over.defaultPrevented).toBe(true);
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
    const files = dt({}, ["Files"]);
    fire("dragenter", files);
    const over = fire("dragover", files);
    expect(over.defaultPrevented).toBe(true); // WebKit must not open the file itself
    expect(files.dropEffect).toBe("none");
    expect(fire("drop", files).defaultPrevented).toBe(true);
    await flush();
    expect(onActive).not.toHaveBeenCalledWith(true);
    expect(onNote).not.toHaveBeenCalled();
    expect(core.import).not.toHaveBeenCalled();
  });

  it("leaves drags that start inside the page (queue rows, links) alone", async () => {
    const data = dt({ "text/uri-list": "https://a.bandcamp.com/album/b" });
    fire("dragstart");
    expect(fire("dragover", data).defaultPrevented).toBe(false);
    expect(fire("drop", data).defaultPrevented).toBe(false);
    await flush();
    expect(core.import).not.toHaveBeenCalled();
    // After the internal drag ends, outside drags work again.
    fire("dragend");
    fire("drop", data);
    await flush();
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
