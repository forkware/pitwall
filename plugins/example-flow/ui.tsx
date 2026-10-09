// The example processes' words in the user's language, for the process editor and the task buttons.
import { addStrings, defineUiPlugin } from "#sdk/ui";

addStrings({
  ru: {
    "process:example-flow.agent": "Задача агенту",
    "process:example-flow.agent:description": "Спрашивает задачу и отдаёт её агенту папки; вы говорите, когда готово.",
    "process:example-flow.note": "Быстрая заметка",
    "process:example-flow.note:description": "Задача с названием по времени, без вопросов: текст напишете потом.",
    "step:example-flow.describe": "Вы описываете задачу",
    "step:example-flow.agent": "Запустить агента",
    "step:example-flow.agent:description": "Запускает агента папки с названием и описанием задачи.",
    "step:example-flow.review": "Спросить меня: готово?",
    "step:example-flow.note": "Назвать заметку",
    "step:example-flow.note:description": "Называет задачу по дате и времени.",
    "question:example-flow.describe:main": "Что за задача?",
    "field:example-flow.describe:title": "Название",
    "field:example-flow.describe:body": "Описание",
    "question:example-flow.review:main": "Готово?",
    "option:example-flow.review:done": "Готово",
  },
});

export default defineUiPlugin({});
