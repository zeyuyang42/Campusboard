/**
 * A stand-in for the <audio> elements audio.ts creates with `new Audio()` (setup.ts stubs the
 * global). It holds plain settable state and never fires events on its own: a test sets the
 * state the real element would have and calls emit(), as the browser's queued tasks would.
 */
export class FakeAudio extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = NaN;
  volume = 1;
  muted = false;
  playbackRate = 1;
  readyState = 0;
  preload = "";
  crossOrigin: string | null = null;
  /** What the next play() does: resolve, or reject with this error (e.g. a NotAllowedError). */
  playError: { name: string } | null = null;
  calls = { play: 0, pause: 0, load: 0, picker: 0 };
  /**
   * WebKit's AirPlay API (#42): a test sets FakeAudio.airPlay before boot() for elements that
   * have webkitShowPlaybackTargetPicker (WKWebView), as Chromium's don't.
   */
  static airPlay = false;
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
  constructor() {
    super();
    if (FakeAudio.airPlay) {
      this.webkitCurrentPlaybackTargetIsWireless = false;
      this.webkitShowPlaybackTargetPicker = () => { this.calls.picker++; };
    }
  }
  /** WebKit reports whether AirPlay targets are nearby. */
  targets(available: boolean) {
    this.dispatchEvent(Object.assign(new Event("webkitplaybacktargetavailabilitychanged"), { availability: available ? "available" : "not-available" }));
  }
  /** The element starts (or stops) playing on an AirPlay target. */
  wireless(on: boolean) {
    this.webkitCurrentPlaybackTargetIsWireless = on;
    this.dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged"));
  }
  private _src = "";

  get src() { return this._src; }
  set src(v: string) { this._src = v; }
  hasAttribute(name: string) { return name === "src" && this._src !== ""; }
  removeAttribute(name: string) { if (name === "src") this._src = ""; }

  play(): Promise<void> {
    this.calls.play++;
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause() {
    this.calls.pause++;
    this.paused = true;
  }
  /** The load algorithm: a new source starts from the top, paused, with nothing known yet. */
  load() {
    this.calls.load++;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = NaN;
    this.readyState = 0;
  }

  /**
   * The track plays to its end: a real element sets paused and ended, then fires "pause"
   * followed by "ended".
   */
  end(state: Partial<Pick<FakeAudio, "currentTime">> = {}) {
    Object.assign(this, { currentTime: Number.isFinite(this.duration) ? this.duration : this.currentTime }, state, { paused: true, ended: true });
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }

  /** Fire an event now, after optionally changing the element's state first. */
  emit(type: string, state: Partial<Pick<FakeAudio, "paused" | "ended" | "currentTime" | "duration" | "readyState">> = {}) {
    Object.assign(this, state);
    this.dispatchEvent(new Event(type));
  }
}
