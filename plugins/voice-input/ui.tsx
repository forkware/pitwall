import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  addStrings,
  attempt,
  Button,
  defineUiPlugin,
  Dialog,
  IconButton,
  refresh,
  rpc,
  selectTask,
  showCustomDialog,
  t,
  toast,
  useSetting,
  type FieldHandle,
} from "#sdk/ui";
import {
  chooseMethod,
  downsample,
  encodeWav,
  offerInstall,
  PhraseSplitter,
  toBase64,
  type DesktopBridge,
  type Method,
} from "./speech.ts";

addStrings({
  en: {
    "voice-input.start": "Dictate",
    "voice-input.stop": "Stop dictating",
    "voice-input.working": "Recognizing speech…",
    "voice-input.windows": "Press Win+H to dictate into the field",
    "voice-input.denied": "The microphone is not allowed: allow it for this page",
    "voice-input.nothing": "No speech recognized",
    "voice-input.missingTitle": "Speech recognition is not set up",
    "voice-input.missingBody":
      "Dictation here needs a speech recognizer (Whisper) on this computer, and it was not found. An agent can install and set it up for you.",
    "voice-input.fix": "Fix",
    "voice-input.cancel": "Cancel",
    "voice-input.task": "Install Whisper",
  },
  ru: {
    "voice-input.start": "Надиктовать",
    "voice-input.stop": "Остановить диктовку",
    "voice-input.working": "Распознаю речь…",
    "voice-input.windows": "Нажмите Win+H, чтобы диктовать в поле",
    "voice-input.denied": "Микрофон запрещён: разрешите его для этой страницы",
    "voice-input.nothing": "Речь не распознана",
    "voice-input.missingTitle": "Распознавание речи не настроено",
    "voice-input.missingBody":
      "Для диктовки здесь нужна программа распознавания речи (Whisper) на этом компьютере, а она не найдена. Агент может установить и настроить её.",
    "voice-input.fix": "Исправить",
    "voice-input.cancel": "Отменить",
    "voice-input.task": "Установка Whisper",
  },
});

type Status = { ready: true } | { ready: false; missing: string; request: string };

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const speechRecognition = (): (new () => Recognition) | undefined =>
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
const desktop = (): DesktopBridge | undefined => (window as any).pitwallDesktop;
/** Set when the browser has Web Speech but cannot reach its service (Brave, Chromium builds): Whisper from then on. */
let browserFailed = false;

function method(): Method {
  return chooseMethod({ desktop: desktop(), speechRecognition: !!speechRecognition(), browserFailed });
}

/** The microphone in the corner of a multiline field. */
function MicButton({ field }: { field: FieldHandle }) {
  const language = useSetting<string>("voice-input.language") ?? "auto";
  const [state, setState] = useState<"idle" | "listening" | "working">("idle");
  // How to stop what is listening now.
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const listenInBrowser = () => {
    const Recognition = speechRecognition()!;
    const recognition = new Recognition();
    recognition.lang = language === "auto" ? document.documentElement.lang || navigator.language : language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        if (result.isFinal) field.insert(result[0]!.transcript.trim());
      }
    };
    recognition.onerror = (e) => {
      if (e.error === "network" || e.error === "service-not-allowed") {
        browserFailed = true;
        setState("working");
        void recordForWhisper();
      } else if (e.error === "not-allowed") toast(t("voice-input.denied"), "error");
      else if (e.error !== "no-speech" && e.error !== "aborted") toast(e.error, "error");
    };
    recognition.onend = () => {
      stop.current = null;
      setState((s) => (s === "listening" ? "idle" : s));
    };
    stop.current = () => recognition.stop();
    setState("listening");
    recognition.start();
  };

  const recordForWhisper = async () => {
    const status = await attempt(() => rpc<Status>("voice-input", "status"));
    if (!status) return setState("idle");
    if (!status.ready) {
      setState("idle");
      await offerInstall(askToInstall, async () => {
        const started = await attempt(() =>
          rpc<{ taskId: string }>("customize-app", "start", { title: t("voice-input.task"), request: status.request }),
        );
        if (!started) return;
        await refresh();
        selectTask(started.taskId);
      });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState("idle");
      return toast(t("voice-input.denied"), "error");
    }
    const context = new AudioContext();
    // Each phrase goes to Whisper as soon as a pause ends it, one at a time, and its text into the field
    // in order, while the user speaks on.
    let queue = Promise.resolve();
    let heard = false;
    // The first phrase's language, so that Whisper detects it once a dictation (it costs as much as recognizing).
    let detected: string | undefined;
    const recognize = (samples: Float32Array) => {
      const wav = encodeWav([downsample(samples, context.sampleRate, 16000)], 16000);
      queue = queue.then(async () => {
        const result = await attempt(() =>
          rpc<{ text: string; language?: string }>("voice-input", "transcribe", { audio: toBase64(wav), detected }),
        );
        detected ??= result?.language;
        if (!result?.text) return;
        field.insert(result.text);
        heard = true;
      });
    };
    const splitter = new PhraseSplitter({ sampleRate: context.sampleRate }, recognize);
    let tap: AudioWorkletNode;
    try {
      tap = await listen(context, stream, (samples) => splitter.push(samples));
    } catch (e) {
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      setState("idle");
      return toast(String(e), "error");
    }
    stop.current = () => {
      stop.current = null;
      tap.port.onmessage = null;
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      splitter.flush();
      setState("working");
      void queue.then(() => {
        setState("idle");
        if (!heard) toast(t("voice-input.nothing"));
      });
    };
    setState("listening");
  };

  const press = async () => {
    if (state === "listening") return stop.current?.();
    if (state === "working") return;
    field.focus();
    const how = method();
    if (how === "dictation") return void (await desktop()!.startDictation());
    if (how === "windows") return toast(t("voice-input.windows"));
    if (how === "browser") return listenInBrowser();
    setState("working");
    await recordForWhisper();
  };

  const label = t(state === "listening" ? "voice-input.stop" : state === "working" ? "voice-input.working" : "voice-input.start");
  const icon = state === "listening" ? Square : state === "working" ? Spinner : Mic;
  return (
    <IconButton
      icon={icon}
      label={label}
      className={state === "listening" ? "animate-pulse text-[var(--danger)] hover:text-[var(--danger)]" : undefined}
      // Keeps the cursor in the field, where the text goes.
      onMouseDown={(e) => e.preventDefault()}
      onClick={press}
    />
  );
}

/** Asks whether an agent should install the speech recognizer; resolves true on "Fix", false on "Cancel" or closing. */
function askToInstall(): Promise<boolean> {
  return new Promise((resolve) =>
    showCustomDialog(({ open, onOpenChange }) => {
      const close = (fix: boolean) => {
        resolve(fix);
        onOpenChange(false);
      };
      return (
        <Dialog
          open={open}
          onOpenChange={(next) => !next && close(false)}
          title={t("voice-input.missingTitle")}
          description={t("voice-input.missingBody")}
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => close(false)}>
              {t("voice-input.cancel")}
            </Button>
            <Button variant="primary" autoFocus onClick={() => close(true)}>
              {t("voice-input.fix")}
            </Button>
          </div>
        </Dialog>
      );
    }),
  );
}

function Spinner(props: { size?: number; className?: string; strokeWidth?: number }) {
  return <LoaderCircle {...props} className="animate-spin" />;
}

/** Mixes the microphone down to one channel in the audio thread and posts it in blocks of about 85 ms. */
const tapSource = `registerProcessor("voice-input-tap", class extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(4096); this.at = 0; }
  process([channels]) {
    const n = channels?.[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const c of channels) sum += c[i];
      this.block[this.at++] = sum / channels.length;
      if (this.at === this.block.length) { this.port.postMessage(this.block, [this.block.buffer]); this.block = new Float32Array(4096); this.at = 0; }
    }
    return true;
  }
});`;

/** Starts feeding the microphone's samples, at the context's rate, to `onSamples`. */
async function listen(context: AudioContext, stream: MediaStream, onSamples: (samples: Float32Array) => void) {
  const url = URL.createObjectURL(new Blob([tapSource], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  // No outputs: the node is a sink, which the browser runs without connecting it to the speakers.
  const tap = new AudioWorkletNode(context, "voice-input-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
  context.createMediaStreamSource(stream).connect(tap);
  return tap;
}

export default defineUiPlugin({ slots: { "field.actions": MicButton } });
