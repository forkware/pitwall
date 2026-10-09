// Over an agent that ended: why, and one button that continues its conversation in the same tab.
import { CirclePause, Play, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { addStrings, attempt, Button, defineUiPlugin, rpc, t, type Continuation, type Session, type Task } from "#sdk/ui";
import { describeEnded } from "./describe.ts";

addStrings({
  en: {
    "ended-sessions.stopped": "The agent was stopped",
    "ended-sessions.gone": "The agent's directory was removed",
    "ended-sessions.archived": "The agent was stopped when the task went to the archive",
    "ended-sessions.finished": "The agent finished",
    "ended-sessions.failed": "The agent exited with an error (code {code})",
    "ended-sessions.ended": "The agent ended",
    "ended-sessions.resumes": "Its conversation is kept: the agent goes on where it stopped.",
    "ended-sessions.afresh": "This agent cannot continue a conversation: it starts a new one in the same directory.",
    "ended-sessions.cannot": "It cannot be started again here: its agent is not installed.",
    "ended-sessions.cannotGone": "Its directory is gone and nothing can bring it back. A new agent starts in the folder with the task's description.",
    "ended-sessions.continue": "Continue the conversation",
    "ended-sessions.startAgain": "Start it again",
    "ended-sessions.restoreAndContinue": "Restore and continue",
    "ended-sessions.fresh": "New agent",
    "ended-sessions.freshHint": "A new conversation that starts with the task's description",
  },
  ru: {
    "ended-sessions.stopped": "Агент остановлен",
    "ended-sessions.gone": "Папка агента удалена",
    "ended-sessions.archived": "Агент остановлен, когда задача ушла в архив",
    "ended-sessions.finished": "Агент завершил работу",
    "ended-sessions.failed": "Агент завершился с ошибкой (код {code})",
    "ended-sessions.ended": "Агент завершился",
    "ended-sessions.resumes": "Разговор сохранён: агент продолжит с того места, где остановился.",
    "ended-sessions.afresh": "Этот агент не умеет продолжать разговор: он начнёт новый в той же папке.",
    "ended-sessions.cannot": "Здесь его не запустить: агент не установлен.",
    "ended-sessions.cannotGone": "Папки больше нет, и восстановить её нечем. Новый агент начнёт в папке проекта с описанием задачи.",
    "ended-sessions.continue": "Продолжить разговор",
    "ended-sessions.startAgain": "Запустить снова",
    "ended-sessions.restoreAndContinue": "Восстановить и продолжить",
    "ended-sessions.fresh": "Новый агент",
    "ended-sessions.freshHint": "Новый разговор, который начнётся с описания задачи",
  },
});

function Ended({ session }: { task: Task; session: Session }) {
  const [continuation, setContinuation] = useState<Continuation | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setContinuation(null);
    void rpc<Continuation>("ended-sessions", "continuation", { sessionId: session.id })
      .then((c) => current && setContinuation(c))
      .catch(() => current && setContinuation({ possible: false, resumes: false, gone: false }));
    return () => {
      current = false;
    };
  }, [session.id, session.state, session.cwd, session.endedAt]);

  if (!continuation) return null;
  const text = describeEnded(session, continuation);
  const run = async (name: "continue" | "fresh") => {
    setBusy(true);
    await attempt(() => rpc("ended-sessions", name, { sessionId: session.id }));
    setBusy(false);
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised px-5 py-3">
      <CirclePause size={18} className="shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium" title={session.exitCode !== null ? `exit code ${session.exitCode}` : undefined}>
          {t(text.title, text.vars)}
        </div>
        <div className="text-xs text-muted">{t(text.detail)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {text.action && (
          <Button variant="primary" icon={Play} disabled={busy} onClick={() => void run("continue")}>
            {t(text.action)}
          </Button>
        )}
        <Button variant={text.action ? "secondary" : "primary"} icon={Plus} disabled={busy} title={t("ended-sessions.freshHint")} onClick={() => void run("fresh")}>
          {t("ended-sessions.fresh")}
        </Button>
      </div>
    </div>
  );
}

export default defineUiPlugin({ slots: { "session.ended": Ended } });
