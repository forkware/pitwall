// whisper.cpp's whisper-server, kept running so that the model is loaded once and not for every phrase.
// One at a time: a different model or command stops the old one; it stops by itself when unused.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { audioContext, clean, type Speech, wavSeconds } from "./whisper.ts";

export interface ServerWhisper {
  model: string;
  server: string;
}

export interface WhisperServerOptions {
  /** Stops after this long without a phrase, to give the memory back (a model takes 0.2–1.5 GB). */
  idleMs?: number;
  /** How long it may take to load the model. */
  startMs?: number;
  /** Called with the pid of a started server, and undefined when it stops: to stop one left over by a crash. */
  onPid?: (pid: number | undefined) => void;
}

interface Running {
  key: string;
  child?: ChildProcess;
  port: number;
  ready: Promise<void>;
  /** Stopped on purpose (unused, another model, the app stopping): not a failure. */
  stopped?: boolean;
}

export class WhisperServer {
  private running: Running | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Phrases being recognized: it does not stop as unused under them. */
  private busy = 0;
  /** When a server failed to start, by its key: whisper-cli does the work for a while instead of retrying it each phrase. */
  private readonly failed = new Map<string, { at: number; reason: string }>();
  private readonly options: WhisperServerOptions;

  constructor(options: WhisperServerOptions = {}) {
    this.options = options;
  }

  /** Starts it, loading the model, without waiting: the microphone's press does this while the user speaks. */
  warm(whisper: ServerWhisper): void {
    if (!this.broken(whisper)) this.start(whisper).ready.catch(() => {});
  }

  /** Recognizes a WAV; throws when the server cannot start or answer (the caller falls back to whisper-cli). */
  async transcribe(whisper: ServerWhisper, wav: Buffer, language = "auto"): Promise<Speech> {
    const failure = this.broken(whisper);
    if (failure) throw new Error(failure);
    const running = this.start(whisper);
    this.busy++;
    try {
      await running.ready;
      return await request(running.port, wav, language || "auto");
    } finally {
      this.busy--;
      this.touch();
    }
  }

  stop(): void {
    clearTimeout(this.idle);
    const running = this.running;
    this.running = undefined;
    if (running) running.stopped = true;
    if (running?.child && running.child.exitCode === null) {
      running.child.kill();
      this.options.onPid?.(undefined);
    }
  }

  private start(whisper: ServerWhisper): Running {
    const key = `${whisper.server}\n${whisper.model}`;
    if (this.running?.key !== key) this.stop();
    this.touch();
    if (this.running) return this.running;
    let output = "";
    const running: Running = { key, port: 0, ready: Promise.resolve() };
    running.ready = (async () => {
      running.port = await freePort();
      if (running.stopped) throw new Error("whisper-server was stopped");
      const args = ["-m", whisper.model, "-t", String(availableParallelism()), "--host", "127.0.0.1", "--port", String(running.port)];
      // -nlp: no second pass of the encoder for the languages' probabilities in verbose_json.
      const child = spawn(whisper.server, [...args, "-nlp"], { stdio: ["ignore", "ignore", "pipe"] });
      running.child = child;
      child.stderr?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-2000)));
      const exited = new Promise<never>((_, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => {
          if (this.running === running) {
            this.running = undefined;
            this.options.onPid?.(undefined);
          }
          const last = output.trim().split("\n").slice(-3).join(" ");
          reject(new Error(`${basename(whisper.server)} exited (${code ?? "killed"})${last ? `: ${last}` : ""}`));
        });
      });
      exited.catch(() => {});
      if (child.pid) this.options.onPid?.(child.pid);
      await Promise.race([exited, health(running.port, this.options.startMs ?? 120_000)]);
      // A first phrase sets the encoder's window: whisper.cpp detects the language ("auto") with the window of the
      // phrase before, the full 30 s on a fresh start. One second of quiet in a known language sets it small.
      await Promise.race([exited, request(running.port, silence(1), "en")]);
    })();
    running.ready.catch((e) => {
      if (running.stopped) return;
      this.failed.set(key, { at: Date.now(), reason: e instanceof Error ? e.message : String(e) });
      if (this.running === running) this.stop();
    });
    this.running = running;
    return running;
  }

  /** Why this server is not tried now, if it failed to start in the last 10 minutes. */
  private broken(whisper: ServerWhisper): string | undefined {
    const key = `${whisper.server}\n${whisper.model}`;
    const failure = this.failed.get(key);
    return failure && Date.now() - failure.at < 10 * 60_000 ? failure.reason : undefined;
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => (this.busy ? this.touch() : this.stop()), this.options.idleMs ?? 10 * 60_000);
    this.idle.unref?.();
  }
}

async function request(port: number, wav: Buffer, language: string): Promise<Speech> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.set("language", language);
  form.set("response_format", "verbose_json");
  form.set("no_timestamps", "true");
  form.set("no_language_probabilities", "true");
  const context = audioContext(wavSeconds(wav));
  if (context) form.set("audio_ctx", String(context));
  const response = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json().catch(() => ({}))) as { text?: string; language?: string; error?: string };
  if (!response.ok || body.error || typeof body.text !== "string") {
    throw new Error(`whisper-server: ${body.error ?? `HTTP ${response.status}`}`);
  }
  // The language comes as its name ("russian"), which whisper.cpp takes back as well as the code.
  return { text: clean(body.text), ...(language === "auto" && body.language ? { language: body.language } : {}) };
}

async function health(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("whisper-server did not start");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A WAV of quiet, 16 kHz mono 16-bit. */
function silence(seconds: number): Buffer {
  const samples = 16000 * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
