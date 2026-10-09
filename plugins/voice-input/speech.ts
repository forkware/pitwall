// Which way the microphone recognizes speech here, and the WAV the Whisper way sends. No React, so tests reach it.

/** What src/desktop/preload.cjs gives the page in the desktop window. */
export interface DesktopBridge {
  platform: string;
  startDictation(): Promise<boolean>;
}

/**
 * - dictation: the desktop window on macOS starts the system's dictation (as Fn Fn does);
 * - windows: the desktop window on Windows, whose voice typing only the user can start (Win+H);
 * - browser: the browser's Web Speech API (free; Chrome sends the audio to Google, Safari to Apple);
 * - whisper: recorded here, recognized by Whisper on the app's machine. The rest: Electron on Linux,
 *   Firefox, and browsers whose Web Speech failed to connect.
 */
export type Method = "dictation" | "windows" | "browser" | "whisper";

export function chooseMethod(env: { desktop?: DesktopBridge; speechRecognition: boolean; browserFailed: boolean }): Method {
  if (env.desktop?.platform === "darwin") return "dictation";
  if (env.desktop?.platform === "win32") return "windows";
  // Electron has the API but no service behind it, so the desktop window never takes it.
  if (!env.desktop && env.speechRecognition && !env.browserFailed) return "browser";
  return "whisper";
}

/**
 * Whisper is missing: the agent that installs it starts only when the user agrees (`ask` resolves true).
 * Resolves to whether it was started.
 */
export async function offerInstall(ask: () => Promise<boolean>, install: () => Promise<void>): Promise<boolean> {
  if (!(await ask())) return false;
  await install();
  return true;
}

export interface SplitterOptions {
  sampleRate: number;
  /** A pause this long ends a phrase (WhisperWriter waits 900 ms). */
  silenceMs?: number;
  /** A phrase with less sound than this is a click or a breath, and is dropped. */
  minSpeechMs?: number;
  /** A phrase is cut here even without a pause: whisper.cpp reads 30 s at a time. */
  maxPhraseMs?: number;
  /** Quiet kept before and after the sound, so the first and last syllables are whole. */
  padMs?: number;
  /** The level (RMS, 0..1) below which nothing counts as speech, however quiet the room. */
  minLevel?: number;
}

const frameMs = 30;
const roomFrames = 3000 / frameMs;

/**
 * Cuts a recording into phrases at the pauses, as it comes: `push` the samples, `onPhrase` gets each phrase
 * once it is followed by a pause, `flush` gives the last one. Speech is a 30 ms frame well above the room's
 * level, the quietest frame of the last 3 s: speech always dips between syllables, a fan or a hum does not,
 * so a steady noise becomes the room and speaking right after the press is still speech.
 */
export class PhraseSplitter {
  private readonly frame: number;
  private readonly silenceFrames: number;
  private readonly minSpeechFrames: number;
  private readonly maxFrames: number;
  private readonly padFrames: number;
  private readonly minLevel: number;
  private pending = new Float32Array(0);
  /** The last quiet frames before a phrase starts. */
  private before: Float32Array[] = [];
  private phrase: Float32Array[] = [];
  private speech = 0;
  private silence = 0;
  /** The levels of the last 3 s of frames. */
  private levels: number[] = [];
  private readonly onPhrase: (samples: Float32Array) => void;

  constructor(options: SplitterOptions, onPhrase: (samples: Float32Array) => void) {
    this.onPhrase = onPhrase;
    const frames = (ms: number) => Math.max(1, Math.round(ms / frameMs));
    this.frame = Math.round((options.sampleRate * frameMs) / 1000);
    this.silenceFrames = frames(options.silenceMs ?? 900);
    this.minSpeechFrames = frames(options.minSpeechMs ?? 200);
    this.maxFrames = frames(options.maxPhraseMs ?? 25_000);
    this.padFrames = frames(options.padMs ?? 300);
    this.minLevel = options.minLevel ?? 0.01;
  }

  push(samples: Float32Array): void {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let at = 0;
    for (; at + this.frame <= all.length; at += this.frame) this.take(all.slice(at, at + this.frame));
    this.pending = all.slice(at);
  }

  /** The phrase being spoken, if there is one: the recording stopped. */
  flush(): void {
    if (this.phrase.length) this.end();
    this.pending = new Float32Array(0);
    this.before = [];
  }

  private take(frame: Float32Array): void {
    const level = rms(frame);
    this.levels.push(level);
    if (this.levels.length > roomFrames) this.levels.shift();
    const voiced = level > Math.max(this.minLevel, Math.min(...this.levels) * 2.5);
    if (!this.phrase.length) {
      if (!voiced) {
        this.before.push(frame);
        if (this.before.length > this.padFrames) this.before.shift();
        return;
      }
      this.phrase = [...this.before, frame];
      this.before = [];
      this.speech = 1;
      this.silence = 0;
      return;
    }
    this.phrase.push(frame);
    if (voiced) {
      this.speech++;
      this.silence = 0;
    } else this.silence++;
    if (this.silence >= this.silenceFrames || this.phrase.length >= this.maxFrames) this.end();
  }

  private end(): void {
    // Of the pause after the phrase, only the padding stays.
    const frames = this.phrase.slice(0, this.phrase.length - Math.max(0, this.silence - this.padFrames));
    const enough = this.speech >= this.minSpeechFrames;
    this.phrase = [];
    this.speech = 0;
    this.silence = 0;
    if (!enough) return;
    const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      out.set(f, at);
      at += f.length;
    }
    this.onPhrase(out);
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / (samples.length || 1));
}

/** Lowers the sample rate (48 kHz from the microphone to the 16 kHz Whisper wants), averaging what falls into each sample. */
export function downsample(samples: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]!;
    out[i] = sum / (end - start || 1);
  }
  return out;
}

/** Mixes channels down to one and encodes 16-bit PCM WAV. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const length = channels[0]?.length ?? 0;
  const out = new Uint8Array(44 + length * 2);
  const view = new DataView(out.buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / channels.length));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
