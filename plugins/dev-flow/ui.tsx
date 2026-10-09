// In the task's details panel: the refined description (what the agent made of the user's words) and where the task
// works (its worktree, its dev stand). In the header, on the stand's step: "Open the stand". Under the header:
// a failed install of the worktree's dependencies, which the user must see.
import { ChevronRight, Copy, ExternalLink, Server, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  addStrings,
  Button,
  cx,
  defineUiPlugin,
  IconButton,
  Markdown,
  refresh,
  rpc,
  selectTask,
  t,
  toast,
  useUi,
  type Task,
  type ProcessRun,
} from "#sdk/ui";
import type { DevMeta } from "./server.ts";

addStrings({
  en: {
    "dev-flow.spec": "Refined description",
    "dev-flow.specHint": "What the agent made of your words; it rewrites it as the task becomes clearer",
    "dev-flow.stand": "Dev stand",
    "dev-flow.standStopped": "Dev stand stopped",
    "dev-flow.standOpen": "Open the stand",
    "dev-flow.copy": "Copy",
    "dev-flow.copied": "Copied",
    "dev-flow.specBy": "the agent refines it as it works",
    // The stand's address is the header's "Open the stand": its question needs no body on the task's page.
    "question:dev-flow.stand:main:body": "",
    "dev-flow.workCopy": "Worktree",
    "dev-flow.copyPath": "Copy the path",
    "dev-flow.port": "Port",
    "dev-flow.dir": "Worktree",
    "dev-flow.branch": "Branch",
    "dev-flow.command": "Command",
    "dev-flow.pid": "PID",
    "dev-flow.merged": "Merged into dev; the agent was stopped and its worktree removed",
    "dev-flow.restoreWorktree": "The worktree comes back where it was, on its branch or, once merged, on a new one from the current dev; the conversation goes on.",
    "dev-flow.installFailed": "Dependencies were not installed in the worktree",
    "dev-flow.installFix": "Fix",
    "dev-flow.installFixTask": "Dependencies install",
    "dev-flow.installDismiss": "Hide",
  },
  ru: {
    "dev-flow.spec": "Уточнённое описание",
    "dev-flow.specHint": "Как агент понял задачу; он уточняет его по ходу работы",
    "dev-flow.stand": "Dev-стенд",
    "dev-flow.standStopped": "Dev-стенд остановился",
    "dev-flow.standOpen": "Открыть стенд",
    "dev-flow.copy": "Скопировать",
    "dev-flow.copied": "Скопировано",
    "dev-flow.specBy": "агент уточняет его по ходу работы",
    "dev-flow.workCopy": "Рабочая копия",
    "dev-flow.copyPath": "Скопировать путь",
    "dev-flow.port": "Порт",
    "dev-flow.dir": "Папка",
    "dev-flow.branch": "Ветка",
    "dev-flow.command": "Команда",
    "dev-flow.pid": "PID",
    "dev-flow.merged": "Слито в dev: агент остановлен, worktree удалён",
    "dev-flow.restoreWorktree": "Worktree вернётся на прежнее место: на свою ветку или, если она слита, на новую от текущего dev. Разговор продолжится.",
    "dev-flow.installFailed": "Зависимости в worktree не установились",
    "dev-flow.installFix": "Исправить",
    "dev-flow.installFixTask": "Установка зависимостей",
    "dev-flow.installDismiss": "Скрыть",
    // The process and its steps, for the process editor
    "process:dev-flow.dev": "Разработка",
    "process:dev-flow.dev:description":
      "Ваши слова → агент называет задачу, спрашивает непонятное и работает в git worktree от dev, пока тесты не пройдут → вы проверяете на dev-стенде → вливается в dev.",
    "status.testing": "Тестирование",
    "status.review": "Проверка",
    "status.merging": "Вливается",
    "status.in_dev": "В dev",
    "step:dev-flow.describe": "Вы описываете задачу",
    "step:dev-flow.refine": "Агент называет задачу",
    "step:dev-flow.refine:description": "Агент без терминала называет задачу и пересказывает просьбу как её описание.",
    "step:dev-flow.clarify": "Уточнить задачу",
    "step:dev-flow.clarify:description": "Задаёт вам вопросы агента и добавляет ответы в описание.",
    "step:dev-flow.workspace": "Рабочая копия от dev",
    "step:dev-flow.workspace:description": "Git worktree на новой ветке от ветки интеграции, если папка в репозитории.",
    "step:dev-flow.code": "Задание агенту",
    "step:dev-flow.code:description": "Запускает агента с описанием или пишет работающему, что исправить.",
    "step:dev-flow.wait": "Агент работает",
    "step:dev-flow.wait:description": "Ждёт `pitwall done` от агента или вашу кнопку «Агент закончил».",
    "step:dev-flow.test": "Тесты",
    "step:dev-flow.manual": "Спросить меня: проверили?",
    "step:dev-flow.manual:description": "Работа прошла тесты: вы поднимаете dev-стенд и проверяете, или решаете без него.",
    "step:dev-flow.stand": "Dev-стенд",
    "step:dev-flow.stand:description": "Запускает dev-стенд в worktree (или оставляет работающий); вы проверяете на нём работу.",
    "step:dev-flow.merge": "Влить в dev",
    "step:dev-flow.merge:description": "Ждёт, пока в ветку интеграции не вливается другая задача, и вливает ветку задачи.",
    "step:dev-flow.test-dev": "Тесты на dev",
    "step:dev-flow.test-dev:description": "Проверяет слияние; если тесты не прошли, откатывает его и возвращает задачу агенту.",
    "outcome:dev.passed:true": "прошли",
    "outcome:dev.passed:false": "не прошли",
    "outcome:dev.devPassed:true": "прошли",
    "outcome:dev.devPassed:false": "не прошли",
    "outcome:dev.decision:stand": "поднять стенд",
    "outcome:dev.decision:ready": "влить",
    "outcome:dev.decision:back": "доработать",
    "outcome:dev.decision:retry": "запустить снова",
    "outcome:dev.mergeResult:merged": "влито",
    "outcome:dev.mergeResult:conflict": "конфликт",
    "outcome:dev.mergeResult:none": "нечего вливать",
    "question:dev-flow.describe:main": "Что нужно сделать?",
    "field:dev-flow.describe:prompt": "Своими словами",
    "field:dev-flow.manual:comment": "Комментарий",
    "field:dev-flow.stand:comment": "Комментарий",
    "question:dev-flow.clarify:main": "Вопросы перед началом работы",
    "question:dev-flow.clarify:main:body": "Ответы попадут в описание задачи. Tab — принять предложенный ответ; пустое поле — агент решит сам.",
    "question:dev-flow.clarify:main:submit": "Продолжить",
    "question:dev-flow.clarify:main:when": "если у агента есть вопросы",
    "question:dev-flow.wait:main": "Агент работает",
    "question:dev-flow.wait:main:body": "Когда закончит, он выполнит `pitwall done`; если нет — нажмите кнопку.",
    "question:dev-flow.wait:main:when": "если агент не сказал, что закончил",
    "option:dev-flow.wait:done": "Агент закончил",
    "question:dev-flow.test:main": "Тесты не прошли несколько раз подряд",
    "question:dev-flow.test:main:when": "после нескольких неудачных запусков подряд",
    "option:dev-flow.test:agent": "Вернуть агенту",
    "option:dev-flow.test:skip": "Продолжить без них",
    "question:dev-flow.manual:main": "Разработка и автотесты завершены. Ждём ручного тестирования",
    "option:dev-flow.manual:stand": "Поднять dev-стенд",
    "option:dev-flow.manual:ready": "Готово к выкладке",
    "option:dev-flow.manual:back": "Вернуть агенту",
    "question:dev-flow.manual:comment": "Что агенту поменять?",
    "question:dev-flow.manual:comment:submit": "Отправить агенту",
    "question:dev-flow.manual:comment:when": "если вы возвращаете агенту",
    "question:dev-flow.stand:main": "Проверьте работу на dev-стенде",
    "option:dev-flow.stand:ready": "Готово к выкладке",
    "option:dev-flow.stand:back": "Вернуть агенту",
    "option:dev-flow.stand:retry": "Запустить снова",
    "question:dev-flow.stand:failed": "Dev-стенд не запустился",
    "question:dev-flow.stand:failed:when": "если стенд не запустился",
    "question:dev-flow.stand:none": "Dev-стенда нет",
    "question:dev-flow.stand:main:body": "",
    "question:dev-flow.stand:none:body": "Команда стенда пуста («Команда dev-стенда» в настройках папки), или у задачи нет папки.",
    "question:dev-flow.stand:comment": "Что агенту поменять?",
    "question:dev-flow.stand:comment:submit": "Отправить агенту",
    "question:dev-flow.stand:comment:when": "если вы возвращаете агенту",
    "question:dev-flow.merge:main": "Ждём ветку интеграции",
    "question:dev-flow.merge:main:when": "пока вливается другая задача",
    "param:dev-flow.test:command": "Команда тестов",
    "param:dev-flow.test-dev:command": "Команда тестов",
    "param:dev-flow.stand:command": "Команда dev-стенда",
    "param:dev-flow.test:command:description": "Пусто: без тестов.",
    "param:dev-flow.test-dev:command:description": "Пусто: без тестов.",
    "param:dev-flow.stand:command:description": "Запускается в worktree, получает свободный порт в PORT. Пусто: без стенда.",
    "key:dev.slug": "имя ветки",
    "key:dev.questions": "вопросы агента",
    "key:dev.repo": "репозиторий",
    "key:dev.workspace": "рабочая копия задачи",
    "key:dev.feedback": "что исправить",
    "key:dev.passed": "прошли ли тесты",
    "key:dev.decision": "ваше решение",
    "key:dev.mergeResult": "чем кончилось слияние",
    "key:dev.devPassed": "прошли ли тесты на dev",
  },
});

/** The worktree's dependencies did not install: the work goes on, and "Fix" hands the failure to Customize the app. */
function InstallWarning({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const failed = (task.meta["dev-flow"] as DevMeta | undefined)?.installFailed;
  if (!failed) return null;
  const fix = async () => {
    setBusy(true);
    try {
      const { taskId } = await rpc<{ taskId: string }>("customize-app", "start", { title: t("dev-flow.installFixTask"), request: failed.request });
      await refresh();
      selectTask(taskId);
    } catch (error) {
      toast(String((error as Error).message ?? error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 border-b border-line bg-[color-mix(in_srgb,var(--s-amber)_12%,transparent)] px-5 py-1.5 text-xs">
      <div className="flex min-h-6 items-center gap-2">
        <button
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ChevronRight size={12} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <TriangleAlert size={13} className="shrink-0 text-[var(--s-amber)]" />
          <span className="truncate font-medium">{t("dev-flow.installFailed")}</span>
        </button>
        <Button size="sm" onClick={fix} disabled={busy}>
          {t("dev-flow.installFix")}
        </Button>
        <IconButton icon={X} label={t("dev-flow.installDismiss")} onClick={() => void rpc("dev-flow", "dismissInstall", { taskId: task.id })} />
      </div>
      {open && (
        <pre className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap pl-[21px] font-mono text-[11px] text-muted">
          {failed.dir}
          {"\n"}
          {failed.output}
        </pre>
      )}
    </div>
  );
}

/** The refined description, in the details panel above the user's own words. */
function Spec({ task }: { task: Task }) {
  const spec = (task.meta["dev-flow"] as DevMeta | undefined)?.spec;
  if (!spec) return null;
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{t("dev-flow.spec")}</span>
        <span className="ml-auto text-[11px] text-faint">{t("dev-flow.specBy")}</span>
      </div>
      <Markdown source={spec} />
    </section>
  );
}

interface StandInfo {
  url: string;
  port: number;
  dir: string | null;
  branch: string | null;
  command: string | null;
  pid: number | null;
  running: boolean;
  output: string;
}

const copy = (text: string) =>
  void navigator.clipboard.writeText(text).then(
    () => toast(t("dev-flow.copied")),
    () => {},
  );

/** The task's stand, polled while something shows it: it can stop, or come back after a restart of the app. */
function useStand(task: Task, on: boolean): StandInfo | null {
  const run = useUi((s) => s.data?.processes.runs.find((r) => r.taskId === task.id));
  const [stand, setStand] = useState<StandInfo | null>(null);
  useEffect(() => {
    setStand(null);
    if (!on) return;
    let live = true;
    const load = () => void rpc<StandInfo | null>("dev-flow", "stand", { taskId: task.id }).then((s) => live && setStand(s), () => {});
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [task.id, on, run?.updatedAt]);
  return stand;
}

/** On the stand's step, the header offers to open it: the rest of it is in the details. */
function OpenStand({ task, run }: { task: Task; run: ProcessRun }) {
  const reviewing = run.process === "dev-flow.dev" && run.state === "waiting" && run.node === "stand";
  const stand = useStand(task, reviewing);
  if (!reviewing || !stand?.running) return null;
  return (
    <Button size="sm" icon={ExternalLink} title={stand.url} onClick={() => window.open(stand.url, "_blank", "noreferrer")}>
      {t("dev-flow.standOpen")}
    </Button>
  );
}

/** Where the task works: its worktree and branch, and its dev stand while one runs. In the details panel. */
function Environment({ task }: { task: Task }) {
  const meta = task.meta["dev-flow"] as DevMeta | undefined;
  const stand = useStand(task, true);
  const Title = ({ children }: { children: React.ReactNode }) => (
    <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{children}</div>
  );
  const rows = (list: [string, string | number | null | undefined][]) => (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
      {list
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint">{t(label)}</dt>
            <dd className="min-w-0 select-text truncate font-mono text-muted" title={String(value)}>
              {value}
            </dd>
          </div>
        ))}
    </dl>
  );
  if (!stand && !meta?.worktree && !meta?.branch) return null;
  return (
    <div className="mb-5">
      {stand && (
        <section className="mb-5">
          <Title>{t(stand.running ? "dev-flow.stand" : "dev-flow.standStopped")}</Title>
          {stand.running && (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs">
              <Server size={13} className="text-accent" />
              <a
                href={stand.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-mono text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {stand.url}
              </a>
              <ExternalLink size={12} className="shrink-0 text-accent" />
              <IconButton icon={Copy} label={t("dev-flow.copy")} onClick={() => copy(stand.url)} />
            </div>
          )}
          {rows([
            ["dev-flow.command", stand.command],
            ["dev-flow.port", stand.port],
            ["dev-flow.pid", stand.pid],
          ])}
          {!stand.running && stand.output && (
            <pre className="mt-1.5 max-h-40 select-text overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{stand.output}</pre>
          )}
        </section>
      )}
      {(meta?.worktree || meta?.branch) && (
        <section>
          <Title>{t("dev-flow.workCopy")}</Title>
          {rows([
            ["dev-flow.branch", meta.branch],
            ["dev-flow.dir", meta.worktree],
          ])}
          {meta.worktree && (
            <Button size="sm" variant="ghost" icon={Copy} className="mt-1 -ml-2" onClick={() => copy(meta.worktree!)}>
              {t("dev-flow.copyPath")}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}

export default defineUiPlugin({
  slots: {
    "task.panel": InstallWarning,
    "task.details.description": Spec,
    "task.details.environment": Environment,
    "process.bar": OpenStand,
  },
});
