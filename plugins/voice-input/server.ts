import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { definePlugin } from "#sdk/server";
import { findWhisper, modelDirs, type Speed, transcribe } from "./whisper.ts";
import { WhisperServer } from "./whisper-server.ts";

/** Codes Whisper and the browsers both know; "auto" lets Whisper detect it and the browser use the page's. */
const languages: [string, string][] = [
  ["auto", "Detect"],
  ["en", "English"],
  ["ru", "Русский"],
  ["uk", "Українська"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["es", "Español"],
  ["it", "Italiano"],
  ["pt", "Português"],
  ["pl", "Polski"],
  ["tr", "Türkçe"],
  ["zh", "中文"],
  ["ja", "日本語"],
];

export default definePlugin((ctx) => {
  ctx.settings.define([
    {
      key: "language",
      label: "Speech language",
      description: "The language voice input expects. Detect: Whisper finds it; the browser takes the page's.",
      type: "select",
      options: languages.map(([value, label]) => ({ value, label })),
      default: "auto",
    },
    {
      key: "whisperCommand",
      label: "Whisper command",
      description: "Path to whisper-cli (whisper.cpp) or whisper (openai-whisper); empty: looked up in PATH.",
      type: "string",
      default: "",
    },
    {
      key: "whisperModel",
      label: "Whisper model",
      description: "whisper.cpp: path to a ggml-*.bin model; openai-whisper: its name. Empty: the one Model choice picks.",
      type: "string",
      default: "",
    },
    {
      key: "speed",
      label: "Whisper model choice",
      description:
        "Which installed whisper.cpp model to use when no model is set. Fast: small (a phrase in about 2 s on a laptop CPU). Accurate: large-v3-turbo (several times slower).",
      type: "select",
      options: [
        { value: "fast", label: "Fast" },
        { value: "accurate", label: "Accurate" },
      ],
      default: "fast",
    },
    {
      key: "keepLoaded",
      label: "Keep the Whisper model loaded",
      description: "Runs whisper-server (next to whisper-cli) while you dictate, so the model is not loaded again for each phrase. It stops after 10 minutes without speech.",
      type: "boolean",
      default: true,
    },
  ]);

  // Looked up on every call, so Whisper installed while the app runs works without a restart.
  const whisper = () =>
    findWhisper({
      command: ctx.settings.get<string>("whisperCommand"),
      model: ctx.settings.get<string>("whisperModel"),
      speed: ctx.settings.get<Speed>("speed") === "accurate" ? "accurate" : "fast",
    });

  // A server left over by a crash of the app holds its model's memory: stop it.
  stopLeftover(ctx.kv.get<number>("serverPid"));
  const server = new WhisperServer({ onPid: (pid) => ctx.kv.set("serverPid", pid ?? null) });
  ctx.events.on("app.stopping", () => server.stop());
  const served = (found: ReturnType<typeof whisper>) =>
    !("missing" in found) && found.kind === "cpp" && found.server && ctx.settings.get<boolean>("keepLoaded") !== false
      ? { model: found.model, server: found.server }
      : undefined;

  ctx.rpc.handle("status", () => {
    const found = whisper();
    if ("missing" in found) return { ready: false, missing: found.missing, request: installRequest(found.missing) };
    // The page asks on the microphone's press: the model loads while the user starts speaking.
    const keep = served(found);
    if (keep) server.warm(keep);
    return { ready: true, kind: found.kind, command: found.command, model: found.model };
  });

  /**
   * `audio`: a WAV file, base64. `detected`: the language an earlier phrase of the same dictation was found to be in,
   * used when the setting is "auto" so that Whisper does not detect it again.
   */
  ctx.rpc.handle("transcribe", async ({ audio, detected }: { audio: string; detected?: string }) => {
    const found = whisper();
    if ("missing" in found) throw new Error(found.missing);
    const setting = ctx.settings.get<string>("language") || "auto";
    // A code ("ru") from whisper-cli, a name ("russian") from whisper-server; whisper.cpp takes both.
    const language = setting === "auto" && detected && /^[a-z]{2,20}$/.test(detected) ? detected : setting;
    const wav = Buffer.from(audio, "base64");
    const keep = served(found);
    if (keep) {
      try {
        return await server.transcribe(keep, wav, language);
      } catch (e) {
        ctx.log("whisper-server failed, using whisper-cli:", e instanceof Error ? e.message : e);
      }
    }
    return transcribe(found, wav, language);
  });
});

function stopLeftover(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("whisper-server")) process.kill(pid);
  } catch {
    // gone, or not Linux
  }
}

/** What the agent Customize the app starts is asked to do when Whisper is missing. */
function installRequest(missing: string): string {
  return [
    `Install Whisper speech recognition for the app's voice input (plugins/voice-input; read its RECIPE.md). The app says: "${missing}".`,
    `This machine: ${platform()}. Check first what is already there: whisper-cli, whisper, ggml models in ${modelDirs(homedir())[0]}.`,
    "Recommended: whisper.cpp (no Python, fast on a CPU, reads the WAV the app records) with the multilingual small model, ggml-small-q5_1.bin (~190 MB) or ggml-small.bin (~470 MB): a phrase in about 2 s.",
    "large-v3-turbo (ggml-large-v3-turbo-q5_0.bin, ~550 MB) recognizes better but is about five times slower without a GPU (the setting voice-input.speed = accurate picks it). Ask the user which one before downloading.",
    `Build whisper.cpp from source (git clone https://github.com/ggml-org/whisper.cpp, cmake -B build -DBUILD_SHARED_LIBS=OFF && cmake --build build -j --config Release), put build/bin/whisper-cli and build/bin/whisper-server (it keeps the model loaded between phrases) into ~/.local/bin and the model into ${modelDirs(homedir())[0]}.`,
    "If you put them elsewhere, set the settings voice-input.whisperCommand and voice-input.whisperModel (the gear in the top bar).",
    "Ask before installing system packages with sudo (build-essential, cmake). Check: `whisper-cli -m <model> -f <whisper.cpp>/samples/jfk.wav -nt` prints the text.",
    "The app finds Whisper by itself, without a restart: tell the user to press the microphone again. This is no change to the app's code, so it needs no issue.",
  ].join("\n");
}
