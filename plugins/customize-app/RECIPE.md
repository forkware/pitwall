# Customize the app

## Intent

The user changes the app by asking for it. A prominent button in the top right starts an agent on the app's own source code, so a wish turns into a change in the user's fork without leaving the app.

## Spec

- The "Customize the app" button sits in `header.actions` and stands out from every other control.
- Pressing it:
  1. finds the folder named after the app (`package.json` name), creating it on first use; if the user deleted it, it is created again;
  2. creates a task in it, "Customization N", with the title in the UI's language;
  3. runs the customization process, a LangGraph graph (`process.ts`). Today it has one node, `runAgent`, which starts the default agent for the task with a prompt about the manifesto, CLAUDE.md and the issue-first rule;
  4. opens the task, so the user sees the agent's terminal.
- Other plugins start it with a request already made: `rpc("customize-app", "start", { title, request })`. The agent then starts on `request` instead of asking what to change (voice-input asks it to install Whisper).
- Agents for tasks in that folder start in the app's source directory.
- The plugin used to be `improve-app`. If its own `kv` has no folder yet, it takes over the folder marked `meta["improve-app"].app`, so an existing user keeps their folder and its tasks.

## Check

`pnpm test` runs `tests/customize-app.test.ts`: one folder for many presses, numbered tasks, the agent's directory and prompt, folder re-creation, a request handed in by another plugin, taking over the old `improve-app` folder.
