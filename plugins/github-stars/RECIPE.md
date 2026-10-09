# GitHub stars

## Intent

Stars are how people find the app on GitHub. A small badge next to "Customize the app" shows how many people have starred the original repository and opens it with one click, so a user who likes the app can star it. Nobody is asked twice and nothing is done for the user: the badge only shows the count and links to the page.

## Spec

- The badge sits in `header.actions`, right after "Customize the app" (plugins render in id order): a star icon and the count (`1.2k` above a thousand). Hover says why to star; a click opens `https://github.com/<repo>` (in the desktop window, in the system browser).
- The repository is the setting `github-stars.repo`, `forkware/pitwall` by default: the original, not the user's fork, because the original is what gets promoted.
- The server asks `https://api.github.com/repos/<repo>` without a token and keeps the count for an hour in `kv` (the anonymous limit is 60 requests an hour). Requests at the same moment share one call.
- When GitHub is out of reach or refuses (offline, rate limit, renamed repository), the badge keeps the last count it had, or shows "Star" without a number; the next try waits five minutes. Nothing throws into the interface.
- No permissions: it only reads.

## Check

`pnpm test` runs `tests/github-stars.test.ts`: the count and link of the original repository, one request an hour, offline gives no count and keeps an old one, the repository setting, short counts. By hand: the badge is next to "Customize the app" and opens GitHub; with the network off and `kv` empty (a fresh data dir) it shows "Star" and the console is clean.

## Proposals (not built yet)

Ways the user and their agents can promote the app. The rule for all of them: an agent prepares, the user publishes. No agent stars, posts or sends anything in the user's name.

**Share button.**
- Where: in the task's menu (`task.menu`) and on the process bar once a task is done (`process.bar`), because the moment worth sharing is a finished result; plus one entry in the palette (`commands`). Not in the top bar: it already holds the two calls to action.
- What it opens: a dialog with a short text an agent drafts from the task (what was asked, what the agent did, how long it took), ending with the repository link and the app's one-line pitch. The user edits it and picks where: copy to clipboard, X/Twitter, Telegram, Reddit, Hacker News (`intent`/`share` URLs open in the browser with the text filled in). Nothing is sent from the app.
- A second kind of share is a process: the process editor already shares a process file (`process-editor` "share"); its link should carry "made with Pitwall" and the repository link.

**Other ways.**
- **Give back the customization.** After a "Customize the app" task is done, offer to open a pull request of the plugin to the original (the agent prepares the branch and the description from `RECIPE.md`; the user presses "Open PR"). Every plugin that lands upstream is a reason for others to come.
- **Plugin catalog.** A page listing plugins other users published (a GitHub topic such as `pitwall-plugin`), installable as a customization request. Publishing your plugin with that topic promotes both.
- **Credit in commits and PRs the agents make in the user's projects**, as an opt-in setting (`Made with Pitwall: <link>` in the PR body), off by default.
- **Ask for a star once, at a good moment**: after the first few done tasks, a dismissible line under the result ("Saved you time? A star helps others find it"), never again after it is dismissed or the star is given.
- **Release notes in the app.** When the original has a new release, the update notice links to it; people who read release notes share them.
- **Showcase**: a command that makes a short recording or screenshot of the board (tasks, agents, process) for the user to post, with the link in the caption.
