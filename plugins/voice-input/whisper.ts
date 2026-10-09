// Finding Whisper on this machine and running it on a WAV file. Two kinds are known:
// whisper.cpp (`whisper-cli` and a ggml model file) and openai-whisper (the `whisper` Python command).
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

export type Whisper =
  /** `server`: whisper.cpp's `whisper-server` next to `whisper-cli`, which keeps the model loaded between phrases. */
  | { kind: "cpp"; command: string; model: string; server?: string }
  | { kind: "openai"; command: string; model: string };

export interface FindOptions {
  /** A path to the command, from the settings; empty: look in PATH. */
  command?: string;
  /** whisper.cpp: a path to the ggml model; openai-whisper: the model's name. Empty: the best one found. */
  model?: string;
  /** Which installed model is the best one: "fast" (small, base) or "accurate" (large-v3-turbo, medium). */
  speed?: Speed;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export type Speed = "fast" | "accurate";

const cppCommands = ["whisper-cli", "whisper-cpp", "whisper.cpp"];
/**
 * Preferred first. On a CPU small recognizes a 3–6 s phrase in ~2 s and large-v3-turbo in ~11 s (RECIPE.md);
 * base is faster still but often wrong, tiny worse.
 */
const modelPreference: Record<Speed, string[]> = {
  fast: ["small", "base", "medium", "large-v3-turbo", "large", "tiny"],
  accurate: ["large-v3-turbo", "medium", "small", "large", "base", "tiny"],
};

export function modelDirs(home: string): string[] {
  return [
    join(home, ".local/share/whisper.cpp/models"),
    join(home, ".cache/whisper.cpp"),
    join(home, "whisper.cpp/models"),
    "/usr/local/share/whisper.cpp/models",
    "/usr/share/whisper.cpp/models",
    "/usr/share/whisper.cpp-model-small", // Debian's model package puts it here
  ];
}

/** Whisper as installed, or why it cannot run. */
export function findWhisper(options: FindOptions = {}): Whisper | { missing: string } {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  // ~/.local/bin is where pipx and hand installs go, and is often missing from a desktop session's PATH.
  const path = [...(env.PATH ?? "").split(delimiter), join(home, ".local/bin")].filter(Boolean);
  const which = (name: string) => path.map((dir) => join(dir, name)).find(isExecutable);

  const explicit = options.command?.trim();
  const command = explicit ? (isExecutable(explicit) ? explicit : undefined) : undefined;
  if (explicit && !command) return { missing: `${explicit} is not an executable file` };

  const cpp = command ? (basename(command) === "whisper" ? undefined : command) : cppCommands.map(which).find(Boolean);
  if (cpp) {
    const model = options.model?.trim() || findModel(modelDirs(home), options.speed ?? "fast");
    if (!model) return { missing: `whisper.cpp is at ${cpp}, but no ggml model was found` };
    if (!existsSync(model)) return { missing: `The model ${model} does not exist` };
    // Only the one built with this whisper-cli: a server from elsewhere may not read the same models.
    const server = join(dirname(cpp), "whisper-server");
    return { kind: "cpp", command: cpp, model, ...(isExecutable(server) ? { server } : {}) };
  }
  const openai = command ?? which("whisper");
  if (openai) return { kind: "openai", command: openai, model: options.model?.trim() || "small" };
  return { missing: "Whisper is not installed" };
}

function findModel(dirs: string[], speed: Speed): string | undefined {
  const files = dirs.flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((f) => /^ggml-.*\.bin$/.test(f) && !f.includes("for-tests"))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  });
  const preference = modelPreference[speed];
  // English-only models (ggml-small.en.bin) after the multilingual one of the same size.
  const rank = (file: string) => {
    const i = preference.findIndex((m) => basename(file).startsWith(`ggml-${m}`));
    return (i < 0 ? preference.length : i) * 2 + (/\.en[.-]/.test(basename(file)) ? 1 : 0);
  };
  return files.sort((a, b) => rank(a) - rank(b))[0];
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface Speech {
  text: string;
  /** The language whisper.cpp detected, when it was asked to ("auto"). */
  language?: string;
}

/**
 * Recognizes speech in a WAV file (16 kHz mono is what whisper.cpp wants). `language`: a code, or "auto", which
 * costs whisper.cpp a second pass of its encoder: the caller passes back the detected one for the next phrases.
 */
export async function transcribe(whisper: Whisper, wav: Buffer, language = "auto"): Promise<Speech> {
  const dir = mkdtempSync(join(tmpdir(), "voice-input-"));
  try {
    const file = join(dir, "speech.wav");
    writeFileSync(file, wav);
    if (whisper.kind === "cpp") {
      const args = ["-m", whisper.model, "-f", file, "-l", language || "auto", "-t", String(availableParallelism())];
      const context = audioContext(wavSeconds(wav));
      if (context) args.push("-ac", String(context));
      // Without -np, which also hides the detected language; the rest of what it says goes to stderr.
      const { stdout, stderr } = await run(whisper.command, [...args, "-nt"]);
      return { text: clean(stdout), language: /auto-detected language: (\w+)/.exec(stderr)?.[1] };
    }
    const args = [file, "--model", whisper.model, "--output_format", "txt", "--output_dir", dir, "--fp16", "False"];
    if (language && language !== "auto") args.push("--language", language);
    await run(whisper.command, args);
    return { text: clean(readFileSync(join(dir, "speech.txt"), "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * whisper.cpp's audio context (`-ac`) for a clip: the encoder always works on a 30 s window (1500 frames, 50 a second),
 * which on a CPU costs the same for a 3 s phrase as for 30 s; a window that fits the clip is several times faster.
 * Below 512 frames it starts repeating itself, so never less. Undefined: the full window (a long or unknown clip).
 */
export function audioContext(seconds: number | undefined): number | undefined {
  if (seconds === undefined || seconds >= 28) return undefined;
  return Math.min(1500, Math.max(512, Math.ceil((seconds * 50 + 128) / 64) * 64));
}

/** How long a 16-bit WAV with a 44-byte header (what encodeWav writes) plays; undefined for anything else. */
export function wavSeconds(wav: Buffer): number | undefined {
  if (wav.length < 44 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") return undefined;
  const bytesPerSecond = wav.readUInt32LE(28);
  return bytesPerSecond ? (wav.length - 44) / bytesPerSecond : undefined;
}

/** One line of text, without the marks whisper.cpp puts for silence and noise: [BLANK_AUDIO], [Music]. */
export function clean(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${basename(command)} failed: ${(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`));
      else resolve({ stdout, stderr });
    });
  });
}
