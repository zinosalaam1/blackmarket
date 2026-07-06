/**
 * Sound effects synthesised via the Web Audio API — no external files needed.
 * All sounds are procedurally generated oscillators, so the module is tiny and
 * works inside Capacitor's WebView exactly as in a browser.
 *
 * Rules:
 *  • Sounds are silently skipped if the user has disabled them (SOUND_KEY).
 *  • AudioContext is created lazily on first call and resumed if suspended.
 *  • Every function is a fire-and-forget — callers don't await anything.
 */

const SOUND_KEY = "bm_sounds";

let _ctx: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (localStorage.getItem(SOUND_KEY) === "off") return null;
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch { return null; }
  }
  if (_ctx.state === "suspended") _ctx.resume().catch(() => {});
  return _ctx;
}

function osc(
  frequency: number,
  type: OscillatorType,
  startGain: number,
  duration: number,
  startAt = 0,
  freqEnd?: number
) {
  const c = ctx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.connect(g);
  g.connect(c.destination);
  o.type = type;
  const t0 = c.currentTime + startAt;
  o.frequency.setValueAtTime(frequency, t0);
  if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + duration);
  g.gain.setValueAtTime(startGain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  o.start(t0);
  o.stop(t0 + duration);
}

/** Short ascending ping — buy confirmed */
export function playBuy() {
  osc(440, "sine", 0.25, 0.12, 0, 880);
}

/** Short descending ping — sell confirmed */
export function playSell() {
  osc(880, "sine", 0.25, 0.12, 0, 440);
}

/** Auction bid placed */
export function playBid() {
  osc(660, "triangle", 0.2, 0.08);
  osc(880, "triangle", 0.2, 0.08, 0.08);
}

/** Market crash event */
export function playCrash() {
  osc(160, "sawtooth", 0.4, 0.9, 0, 40);
  osc(80, "square", 0.2, 0.5, 0.1);
}

/** BUSTED — three descending alarm tones */
export function playBusted() {
  [880, 660, 440].forEach((f, i) => osc(f, "sawtooth", 0.35, 0.14, i * 0.16));
}

/** Assassination / frozen — heavy impact */
export function playAssassinated() {
  osc(200, "sawtooth", 0.5, 0.6, 0, 40);
  osc(100, "square", 0.3, 0.4, 0.05);
}

/** Bounty placed on you */
export function playBountyReceived() {
  [440, 330, 220].forEach((f, i) => osc(f, "triangle", 0.25, 0.12, i * 0.13));
}

/** Pump & dump initiated */
export function playPump() {
  osc(330, "sine", 0.2, 0.15, 0, 660);
  osc(660, "sine", 0.2, 0.15, 0.15, 1320);
}

/** Dump crash fires */
export function playDump() {
  playCrash();
}

/** COLLAPSE phase — single urgent tick (call every 2s) */
export function playCollapseTick() {
  osc(900, "square", 0.12, 0.04);
}

/** Game over fanfare */
export function playGameOver() {
  [523, 659, 784, 1047].forEach((f, i) => osc(f, "sine", 0.28, 0.35, i * 0.18));
}

/** Loan taken */
export function playLoanTaken() {
  osc(220, "sawtooth", 0.3, 0.2, 0, 110);
}

/** Loan repaid */
export function playLoanRepaid() {
  [440, 554, 659].forEach((f, i) => osc(f, "sine", 0.2, 0.2, i * 0.1));
}

/** Game started — subtle alert */
export function playGameStart() {
  [440, 660, 880].forEach((f, i) => osc(f, "sine", 0.3, 0.25, i * 0.12));
}

export function soundsEnabled(): boolean {
  return localStorage.getItem(SOUND_KEY) !== "off";
}

export function setSoundsEnabled(on: boolean) {
  localStorage.setItem(SOUND_KEY, on ? "on" : "off");
}
