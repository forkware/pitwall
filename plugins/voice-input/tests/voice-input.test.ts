import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../../../src/sdk/server.ts";
import { root, testCore } from "../../../test/helpers.ts";
import { chooseMethod, downsample, encodeWav, offerInstall, PhraseSplitter, toBase64 } from "../speech.ts";
import { audioContext, clean, findWhisper, transcribe, wavSeconds } from "../whisper.ts";
import { WhisperServer } from "../whisper-server.ts";

/** A home with ~/.local/bin and a model directory, and a PATH with nothing in it. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "voice-input-test-"));
  const bin = join(home, ".local/bin");
  const models = join(home, ".local/share/whisper.cpp/models");
  mkdirSync(bin, { recursive: true });
  mkdirSync(models, { recursive: true });
  const env = { PATH: join(home, "empty") };
  const script = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  return { home, bin, models, env, script };
}

describe("finding Whisper", () => {
  it("says it is missing when nothing is installed", () => {
    const { home, env } = sandbox();
    expect(findWhisper({ home, env })).toEqual({ missing: "Whisper is not installed" });
  });

  it("wants a model for whisper.cpp and prefers the better one", () => {
    const { home, env, models, script } = sandbox();
    const cli = script("whisper-cli", "true");
    expect(findWhisper({ home, env })).toHaveProperty("missing", expect.stringContaining("no ggml model"));
    writeFileSync(join(models, "ggml-tiny.bin"), "");
    writeFileSync(join(models, "ggml-small.bin"), "");
    writeFileSync(join(models, "ggml-tiny-for-tests.bin"), "");
    expect(findWhisper({ home, env })).toEqual({ kind: "cpp", command: cli, model: join(models, "ggml-small.bin") });
  });

  it("takes a fast model by default and the accurate one when asked, multilingual before English-only", () => {
    const { home, env, models, script } = sandbox();
    script("whisper-cli", "true");
    for (const name of ["large-v3-turbo-q5_0", "small.en", "small-q5_1", "base"]) writeFileSync(join(models, `ggml-${name}.bin`), "");
    const model = (speed?: "fast" | "accurate") => (findWhisper({ home, env, speed }) as { model: string }).model;
    expect(model()).toBe(join(models, "ggml-small-q5_1.bin"));
    expect(model("accurate")).toBe(join(models, "ggml-large-v3-turbo-q5_0.bin"));
  });

  it("finds whisper-server next to whisper-cli", () => {
    const { home, env, models, script } = sandbox();
    writeFileSync(join(models, "ggml-small.bin"), "");
    script("whisper-cli", "true");
    expect(findWhisper({ home, env })).not.toHaveProperty("server");
    const server = script("whisper-server", "true");
    expect(findWhisper({ home, env })).toHaveProperty("server", server);
  });

  it("takes openai-whisper when there is no whisper.cpp", () => {
    const { home, env, script } = sandbox();
    const whisper = script("whisper", "true");
    expect(findWhisper({ home, env })).toEqual({ kind: "openai", command: whisper, model: "small" });
  });

  it("follows the settings", () => {
    const { home, env, script } = sandbox();
    const cli = script("my-whisper", "true");
    const model = join(home, "model.bin");
    writeFileSync(model, "");
    expect(findWhisper({ home, env, command: cli, model })).toEqual({ kind: "cpp", command: cli, model });
    expect(findWhisper({ home, env, command: join(home, "nope") })).toHaveProperty("missing");
  });
});

describe("recognizing", () => {
  it("runs whisper.cpp on the WAV with the language and cleans its output", async () => {
    const { home, env, models, script } = sandbox();
    writeFileSync(join(models, "ggml-base.bin"), "");
    // Prints its arguments and the size of the file after -f.
    script(
      "whisper-cli",
      'echo "[BLANK_AUDIO] args: $*"; echo "auto-detected language: de (p = 0.9)" >&2; while [ "$1" != "-f" ]; do shift; done; echo "bytes $(wc -c < "$2")"',
    );
    const whisper = findWhisper({ home, env });
    if ("missing" in whisper) throw new Error(whisper.missing);
    const { text, language } = await transcribe(whisper, Buffer.from("RIFF1234"), "ru");
    expect(text).toMatch(/^args: -m .*ggml-base\.bin -f .*speech\.wav -l ru -t \d+ -nt bytes 8$/);
    expect(language).toBe("de");
    // A phrase of 2 s gets a window that fits it instead of the full 30 s.
    const phrase = Buffer.from(encodeWav([new Float32Array(32000)], 16000));
    expect((await transcribe(whisper, phrase, "auto")).text).toMatch(/ -l auto -t \d+ -ac 512 -nt bytes 64044$/);
  });

  it("sizes whisper.cpp's audio context to the clip, never below 512 frames, the full window for long clips", () => {
    expect(audioContext(2)).toBe(512);
    expect(audioContext(11)).toBe(704);
    expect(audioContext(20)).toBe(1152);
    expect(audioContext(29)).toBeUndefined();
    expect(audioContext(undefined)).toBeUndefined();
    expect(wavSeconds(Buffer.from(encodeWav([new Float32Array(24000)], 16000)))).toBe(1.5);
    expect(wavSeconds(Buffer.from("RIFF1234"))).toBeUndefined();
  });

  it("reads openai-whisper's text file", async () => {
    const { home, env, script } = sandbox();
    script("whisper", 'while [ "$1" != "--output_dir" ]; do shift; done; printf "Привет,\\n мир\\n" > "$2/speech.txt"');
    const whisper = findWhisper({ home, env });
    if ("missing" in whisper) throw new Error(whisper.missing);
    expect(await transcribe(whisper, Buffer.from("x"))).toEqual({ text: "Привет, мир" });
  });

  it("cleans whisper.cpp's marks", () => {
    expect(clean(" [Music]\n Hello there. [BLANK_AUDIO]\n")).toBe("Hello there.");
  });
});

/**
 * A whisper-server that answers like the real one: /health, and /inference with what it was sent as the text.
 * It notes each start and request in `log`; `fail` makes it exit at once.
 */
function fakeServer(bin: string, { fail = false } = {}) {
  const log = join(bin, "server.log");
  const file = join(bin, "whisper-server");
  writeFileSync(
    file,
    String.raw`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, "start " + args.join(" ") + "\n");
if (${fail}) process.exit(3);
const field = (body, name) => new RegExp('name="' + name + '"\r\n\r\n([^\r]*)').exec(body)?.[1];
require("node:http").createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c.toString("latin1")));
  req.on("end", () => {
    if (req.url === "/health") return res.end('{"status":"ok"}');
    const language = field(body, "language");
    const text = "[BLANK_AUDIO] lang " + language + " ctx " + field(body, "audio_ctx") + " nlp " + field(body, "no_language_probabilities");
    fs.appendFileSync(${JSON.stringify(log)}, "inference " + language + "\n");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text, language: language === "auto" ? "russian" : language }));
  });
}).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
`,
  );
  chmodSync(file, 0o755);
  return { server: file, log: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("whisper-server", () => {
  const phrase = Buffer.from(encodeWav([new Float32Array(48000)], 16000)); // 3 s

  it("starts once with the model, warms up, and recognizes phrase after phrase", async () => {
    const { bin, home } = sandbox();
    const { server, log } = fakeServer(bin);
    const pids: (number | undefined)[] = [];
    const whisper = new WhisperServer({ onPid: (pid) => pids.push(pid) });
    const model = join(home, "ggml-small.bin");
    try {
      whisper.warm({ server, model });
      expect(await whisper.transcribe({ server, model }, phrase, "auto")).toEqual({
        text: "lang auto ctx 512 nlp true",
        language: "russian",
      });
      expect(await whisper.transcribe({ server, model }, phrase, "russian")).toEqual({ text: "lang russian ctx 512 nlp true" });
      const lines = log();
      expect(lines.filter((l) => l.startsWith("start"))).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^start -m ${model} -t \\d+ --host 127\\.0\\.0\\.1 --port \\d+ -nlp$`));
      // The warm-up in a known language sets the encoder's window before the first "auto".
      expect(lines.slice(1)).toEqual(["inference en", "inference auto", "inference russian"]);
      expect(pids).toHaveLength(1);
    } finally {
      whisper.stop();
    }
    expect(pids.at(-1)).toBeUndefined();
  });

  it("starts another one for another model", async () => {
    const { bin, home } = sandbox();
    const { server, log } = fakeServer(bin);
    const whisper = new WhisperServer();
    try {
      await whisper.transcribe({ server, model: join(home, "a.bin") }, phrase, "en");
      await whisper.transcribe({ server, model: join(home, "b.bin") }, phrase, "en");
      expect(log().filter((l) => l.startsWith("start"))).toHaveLength(2);
    } finally {
      whisper.stop();
    }
  });

  it("stops when unused", async () => {
    const { bin, home } = sandbox();
    const { server } = fakeServer(bin);
    let stopped!: () => void;
    const done = new Promise<void>((resolve) => (stopped = resolve));
    const whisper = new WhisperServer({ idleMs: 300, onPid: (pid) => pid === undefined && stopped() });
    await whisper.transcribe({ server, model: join(home, "a.bin") }, phrase, "en");
    await done;
  });

  it("fails fast and is not started again for every phrase when it cannot start", async () => {
    const { bin, home } = sandbox();
    const { server, log } = fakeServer(bin, { fail: true });
    const whisper = new WhisperServer();
    const model = join(home, "a.bin");
    await expect(whisper.transcribe({ server, model }, phrase, "en")).rejects.toThrow(/exited \(3\)/);
    await expect(whisper.transcribe({ server, model }, phrase, "en")).rejects.toThrow(/exited \(3\)/);
    expect(log()).toHaveLength(1);
  });
});

describe("the plugin", () => {
  it("defines its settings and hands an install request to Customize the app when Whisper is missing", async () => {
    const core = await testCore({ pluginsDir: join(root, "plugins") });
    const plugin = core.plugins.loaded.get("voice-input")!;
    expect(core.settings.defs().map((d) => d.key)).toEqual(
      expect.arrayContaining(["voice-input.language", "voice-input.whisperCommand", "voice-input.whisperModel"]),
    );
    core.settings.set("voice-input.whisperCommand", "/nonexistent/whisper-cli");
    const status = (await plugin.rpc.get("status")!({})) as { ready: boolean; request: string };
    expect(status.ready).toBe(false);
    expect(status.request).toContain("whisper.cpp");
    expect(status.request).toContain("voice-input.whisperCommand");
  });

  it("detects the language once a dictation: later phrases bring it back, a chosen language wins", async () => {
    const { home, script } = sandbox();
    const model = join(home, "model.bin");
    writeFileSync(model, "");
    const core = await testCore({ pluginsDir: join(root, "plugins") });
    const transcribe = core.plugins.loaded.get("voice-input")!.rpc.get("transcribe")!;
    core.settings.set("voice-input.whisperCommand", script("whisper-cli", 'echo "$*"'));
    core.settings.set("voice-input.whisperModel", model);
    const language = async (detected?: string) =>
      /-l (\S+)/.exec(((await transcribe({ audio: "", detected })) as { text: string }).text)?.[1];
    expect(await language()).toBe("auto");
    expect(await language("ru")).toBe("ru");
    expect(await language("ru; rm -rf")).toBe("auto");
    expect(await language("russian")).toBe("russian");
    core.settings.set("voice-input.language", "en");
    expect(await language("ru")).toBe("en");
  });

  it("recognizes with whisper-server next to whisper-cli, and with whisper-cli when the server fails or is off", async () => {
    const { bin, home, script } = sandbox();
    const model = join(home, "model.bin");
    writeFileSync(model, "");
    const core = await testCore({ pluginsDir: join(root, "plugins") });
    const plugin = core.plugins.loaded.get("voice-input")!;
    const transcribe = async () => ((await plugin.rpc.get("transcribe")!({ audio: "" })) as { text: string }).text;
    core.settings.set("voice-input.whisperCommand", script("whisper-cli", 'echo "cli $*"'));
    core.settings.set("voice-input.whisperModel", model);
    // The core's close stops the server (app.stopping).
    fakeServer(bin);
    expect(await transcribe()).toBe("lang auto ctx undefined nlp true");
    core.settings.set("voice-input.keepLoaded", false);
    expect(await transcribe()).toMatch(/^cli -m /);
    core.settings.set("voice-input.keepLoaded", true);
    fakeServer(bin, { fail: true });
    const other = join(home, "other.bin");
    writeFileSync(other, "");
    core.settings.set("voice-input.whisperModel", other);
    expect(await transcribe()).toMatch(/^cli -m .*other\.bin/);
  });
});

describe("choosing the way", () => {
  const desktop = (platform: string) => ({ platform, startDictation: async () => true });
  it("uses the system's dictation on a Mac, Web Speech in browsers that have it, Whisper otherwise", () => {
    expect(chooseMethod({ desktop: desktop("darwin"), speechRecognition: true, browserFailed: false })).toBe("dictation");
    expect(chooseMethod({ desktop: desktop("win32"), speechRecognition: true, browserFailed: false })).toBe("windows");
    expect(chooseMethod({ desktop: desktop("linux"), speechRecognition: true, browserFailed: false })).toBe("whisper");
    expect(chooseMethod({ speechRecognition: true, browserFailed: false })).toBe("browser");
    expect(chooseMethod({ speechRecognition: true, browserFailed: true })).toBe("whisper");
    expect(chooseMethod({ speechRecognition: false, browserFailed: false })).toBe("whisper");
  });
});

describe("Whisper missing", () => {
  it("starts the installing agent only when the user picks Fix", async () => {
    let installs = 0;
    const install = async () => void installs++;
    expect(await offerInstall(async () => false, install)).toBe(false);
    expect(installs).toBe(0);
    expect(await offerInstall(async () => true, install)).toBe(true);
    expect(installs).toBe(1);
  });
});

describe("WAV", () => {
  it("encodes 16-bit mono PCM, mixing the channels", () => {
    const wav = encodeWav([new Float32Array([1, -1, 0]), new Float32Array([1, -1, 1])], 16000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((i) => view.getInt16(44 + i * 2, true))).toEqual([32767, -32768, 16383]);
    expect(atob(toBase64(wav)).length).toBe(wav.length);
  });
});

describe("phrases", () => {
  const rate = 16000;
  /** The hiss of a quiet room, with `level` of something on top: speech (syllables, three a second) or a hum. */
  const sound = (seconds: number, level: number, kind: "speech" | "hum" = "speech") =>
    Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => {
      const syllables = kind === "speech" ? Math.abs(Math.sin((Math.PI * 3 * i) / rate)) : 1;
      return level * syllables * Math.sin(i / 3) + (i % 7 === 0 ? 0.002 : -0.002);
    });
  const join = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
    return out;
  };
  const split = (audio: Float32Array, options = {}) => {
    const phrases: number[] = [];
    const splitter = new PhraseSplitter({ sampleRate: rate, ...options }, (p) => phrases.push(p.length / rate));
    // In blocks of the size the page posts, so frames cross them.
    for (let i = 0; i < audio.length; i += 4096) splitter.push(audio.subarray(i, i + 4096));
    return { phrases, flush: () => (splitter.flush(), phrases) };
  };

  it("sends a phrase once a pause ends it, with a little quiet around it, and the last one on stop", () => {
    const audio = join(sound(0.5, 0), sound(1, 0.3), sound(1.2, 0), sound(0.6, 0.2), sound(0.3, 0));
    const { phrases, flush } = split(audio);
    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toBeGreaterThan(1.4);
    expect(phrases[0]).toBeLessThan(1.8);
    expect(flush()).toHaveLength(2);
    expect(phrases[1]).toBeGreaterThan(0.6);
    expect(phrases[1]).toBeLessThan(1.3);
  });

  it("keeps a phrase whole across a short breath, and drops clicks", () => {
    const audio = join(sound(1, 0.3), sound(0.4, 0), sound(1, 0.3), sound(1, 0), sound(0.06, 0.5), sound(1.5, 0));
    expect(split(audio).flush()).toHaveLength(1);
  });

  it("does not take a steady hum for speech, and hears speech that starts at once", () => {
    const hum = sound(4, 0.05, "hum");
    expect(split(join(hum, sound(1, 0.4), hum)).flush()).toHaveLength(1);
    expect(split(join(sound(2, 0.3), sound(1.5, 0))).phrases).toHaveLength(1);
  });

  it("cuts speech without pauses before whisper.cpp's 30 s", () => {
    const { flush } = split(sound(12, 0.3), { maxPhraseMs: 5000 });
    const phrases = flush();
    expect(phrases.length).toBe(3);
    expect(Math.max(...phrases)).toBeLessThanOrEqual(5.4);
  });

  it("downsamples 48 kHz to 16 kHz", () => {
    expect([...downsample(new Float32Array([0, 0.3, 0.6, 1, 1, 1]), 48000, 16000)].map((x) => +x.toFixed(2))).toEqual([0.3, 1]);
    const same = new Float32Array(3);
    expect(downsample(same, 16000, 16000)).toBe(same);
  });
});
