// Steps in words: their stand-in's words in Russian. The editor's "New step in words" talks to this plugin.
import { addStrings, defineUiPlugin } from "#sdk/ui";

addStrings({
  ru: {
    "step:prompt-steps.pending": "Шаг делается",
    "step:prompt-steps.pending:description": "Держит место шага, который агент делает с кодом; замените его на шаг, когда он будет готов.",
    "param:prompt-steps.pending:description": "Что должен делать шаг",
    "param:prompt-steps.pending:task": "Задача, в которой его делают",
  },
});

export default defineUiPlugin({});
