// The mini player: a remote for the main window's player store. State arrives over the bus
// (parseMiniState), commands go back (MiniCommand); nothing here plays audio or opens the
// database. The palette and theme are the main window's, painted with setProperty only.
import { useEffect, useRef, useState } from "react";
import { applyTheme, extrapolatePosition, MINI_EVENTS, parseMiniState, parseTheme, type MiniCommand, type MiniState } from "@bc/core";
import { createBus, type MiniBus } from "./bus";
import { hideMini, initMiniWindow, savedOnTop, setOnTop, setTall, TALL_MIN_HEIGHT } from "./window";
import { ArtImage } from "../components/ArtImage";
import { CloseIcon, ExpandIcon, NextIcon, PauseIcon, PinIcon, PlayIcon, PrevIcon, SquareIcon, StripIcon } from "../components/Icons";
import { formatDuration } from "../lib/format";

let bus: MiniBus | null = null;
const send = (cmd: MiniCommand) => void bus?.send(MINI_EVENTS.command, cmd).catch(() => undefined);

function paint(s: MiniState) {
  const root = document.documentElement;
  const theme = parseTheme(s.theme).theme;
  if (theme) applyTheme(theme, root);
  const p = s.palette;
  if (p) {
    root.style.setProperty("--accent", p.accent);
    root.style.setProperty("--accent-text", p.accentText);
    root.style.setProperty("--ambient-1", p.ambient1);
    root.style.setProperty("--ambient-2", p.ambient2);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-text");
    root.style.setProperty("--ambient-1", "transparent");
    root.style.setProperty("--ambient-2", "transparent");
  }
}

/** The state plus when it arrived, so the position can be extrapolated between ticks. */
function useMiniState() {
  const [st, setSt] = useState<{ s: MiniState; at: number } | null>(null);
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      bus = await createBus("main");
      const unlisten = await bus.on(MINI_EVENTS.state, (payload) => {
        const s = parseMiniState(payload);
        if (!s) return;
        paint(s);
        setSt({ s, at: performance.now() });
      });
      if (cancelled) { unlisten(); return; }
      off = unlisten;
      send({ type: "hello" });
    })();
    // Shown again after being hidden: the main window may have changed track meanwhile.
    const onVis = () => { if (document.visibilityState === "visible") send({ type: "hello" }); };
    document.addEventListener("visibilitychange", onVis);
    void initMiniWindow();
    return () => { cancelled = true; off?.(); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return st;
}

/** Re-render a few times a second while playing, for the extrapolated position. */
function useTicker(on: boolean) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [on]);
}

function Seek({ position, duration }: { position: number; duration: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;
  const pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  const at = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };
  return (
    <div className="mini-seek">
      <span>{formatDuration(shown)}</span>
      <div
        className="bar" ref={bar} data-testid="mini-seek"
        onPointerDown={(e) => { if (!duration) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); setScrub(at(e)); }}
        onPointerMove={(e) => { if (scrub !== null) setScrub(at(e)); }}
        onPointerUp={(e) => { if (scrub !== null) { send({ type: "seek", sec: at(e) }); setScrub(null); } }}
      >
        <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
      </div>
      <span>{duration ? formatDuration(duration) : "–:––"}</span>
    </div>
  );
}

export function MiniPlayer() {
  const st = useMiniState();
  const s = st?.s ?? null;
  const playing = s?.status === "playing";
  useTicker(playing);
  const [onTop, setOnTopState] = useState(savedOnTop);
  const [tall, setTallState] = useState(() => window.innerHeight >= TALL_MIN_HEIGHT);
  useEffect(() => {
    const onResize = () => setTallState(window.innerHeight >= TALL_MIN_HEIGHT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useSelftestHook(s);

  const track = s?.track ?? null;
  const position = st ? extrapolatePosition(st.s, performance.now() - st.at) : 0;

  return (
    <div className={`mini ${tall ? "tall" : "compact"}`} data-tauri-drag-region data-status={s?.status ?? "idle"}>
      <div className="mini-ambient" aria-hidden="true" />
      <div className="mini-art" data-tauri-drag-region>
        {track?.artId ? <ArtImage artId={track.artId} size={tall ? 16 : 7} alt="" /> : null}
        {/* The art is a drag handle too; an <img> would otherwise start a native image drag. */}
        <div className="mini-art-cover" data-tauri-drag-region />
      </div>
      <div className="mini-body" data-tauri-drag-region>
        <div className="mini-text" data-tauri-drag-region>
          <div className="mini-title" data-tauri-drag-region data-testid="mini-title" title={track?.title}>{track ? track.title : "Nothing playing"}</div>
          {track && <div className="mini-artist" data-tauri-drag-region title={`${track.artist}, ${track.album}`}>{track.artist}</div>}
        </div>
        <div className="mini-row" data-tauri-drag-region>
          <div className="mini-buttons">
            <button className="mini-btn" data-cmd="prev" title="Previous" disabled={!track} onClick={() => send({ type: "prev" })}><PrevIcon /></button>
            <button className="mini-btn play" data-cmd="toggle" title={playing ? "Pause" : "Play"} disabled={!track} onClick={() => send({ type: "toggle" })}>
              {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
            </button>
            <button className="mini-btn" data-cmd="next" title="Next" disabled={!track} onClick={() => send({ type: "next" })}><NextIcon /></button>
          </div>
          <div className="mini-tools">
            <button className={`mini-btn small ${onTop ? "on" : ""}`} title={onTop ? "Keep on top: on" : "Keep on top: off"} aria-pressed={onTop}
              onClick={() => { const v = !onTop; setOnTopState(v); void setOnTop(v); }}><PinIcon size={15} /></button>
            <button className="mini-btn small" title={tall ? "Compact" : "Show artwork"} onClick={() => void setTall(!tall)}>
              {tall ? <StripIcon size={15} /> : <SquareIcon size={15} />}
            </button>
            <button className="mini-btn small" data-cmd="showMain" title="Show main window" onClick={() => send({ type: "showMain" })}><ExpandIcon size={15} /></button>
            <button className="mini-btn small" title="Close mini player" onClick={() => void hideMini()}><CloseIcon size={15} /></button>
          </div>
        </div>
        <Seek position={position} duration={s?.duration ?? 0} />
      </div>
    </div>
  );
}

/**
 * VITE_SELFTEST only: the main window's selftest asks this window to press a button (the
 * real click path) or seek, and to report what it shows and whether its window permissions
 * work. Absent from normal builds.
 */
function useSelftestHook(s: MiniState | null) {
  const latest = useRef(s);
  latest.current = s;
  useEffect(() => {
    if (import.meta.env.VITE_SELFTEST !== "1") return;
    let off: (() => void) | null = null;
    void (async () => {
      const b = bus ?? (await createBus("main"));
      off = await b.on("mini:selftest", async (payload) => {
        const req = payload as { do?: string; cmd?: string; sec?: number; id?: number };
        if (req.do === "click") (document.querySelector(`[data-cmd="${String(req.cmd)}"]`) as HTMLButtonElement | null)?.click();
        if (req.do === "seek" && typeof req.sec === "number") send({ type: "seek", sec: req.sec });
        const report: Record<string, unknown> = {
          id: req.id,
          title: document.querySelector('[data-testid="mini-title"]')?.textContent ?? null,
          status: latest.current?.status ?? null,
          position: latest.current?.position ?? null,
          accent: document.documentElement.style.getPropertyValue("--accent") || null,
        };
        if (req.do === "report") {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const w = getCurrentWindow();
          report.label = w.label;
          report.setOnTop = await w.setAlwaysOnTop(savedOnTop()).then(() => "ok", (e) => String(e));
          report.drag = await w.startDragging().then(() => "ok", (e) => String(e));
          // Must be refused: the mini capability has no database or http access.
          report.sqlDenied = await import("@tauri-apps/api/core").then(({ invoke }) => invoke("plugin:sql|select", { db: "x", query: "SELECT 1", values: [] }))
            .then(() => false, (e) => String(e).includes("not allowed"));
          report.commandDenied = await import("@tauri-apps/api/core").then(({ invoke }) => invoke("library_db_url"))
            .then(() => false, (e) => String(e).includes("not allowed"));
        }
        await b.send("mini:selftest-result", report);
      });
    })();
    return () => off?.();
  }, []);
}
