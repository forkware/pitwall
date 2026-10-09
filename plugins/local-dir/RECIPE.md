# Local directory

## Intent

A folder can stand for a project on disk. Agents for its tasks start in that directory instead of a scratch one.

## Spec

- Folder menu: "Bind a directory…" opens a picker that walks the server's disks, so it works in the browser too:
  - clicking a folder opens it; the path above the list is clickable, with Up; Home goes to the home directory;
  - on Windows a row of drives (C:, D:, …, plus the network share you are on) switches disks; a drive that does not answer within 1.5 s is left out;
  - the path field takes a typed or pasted path (`~`, quotes from "Copy as path", a bare `D:`): Enter opens it, a second Enter chooses it;
  - keyboard in the list: arrows, Home/End, Backspace goes up, letters jump to a folder;
  - hidden folders (`.name`, `$name`) are shown on request; a folder that cannot be read says so instead of a list;
  - "Unbind" when the folder is bound. A path that is not a directory is refused with a message under the field.
- The New folder dialog has a "Directory on disk" field (slot `folder.create`) with a button that opens the picker. It starts at `~`; a subfolder starts at the directory it inherits. On create the path is checked first (a bad one keeps the dialog open with the message), then bound, `~` expanded to the absolute home directory. An empty field, or a subfolder's unchanged inherited directory, leaves the folder unbound, so a subfolder keeps following its parent.
- The folder's page has a "Directory" section: the bound directory, or the one inherited and from which folder, and a button to change it.
- The binding is stored in `folder.meta["local-dir"].path` and shown as a badge with the directory's name.
- The nearest bound folder up the tree wins, so subfolders inherit their parent's directory.

## Check

`plugins/local-dir/tests/browse.test.ts`: listing, paths and drives (Windows paths through `path.win32`, so they run anywhere).
`plugins/local-dir/tests/binding.test.ts`: what the New folder field starts with and what it binds. `tests/server.test.ts`: `~` is stored as the home directory, another path as given.

Open New folder: the field says `~`. Create a folder without touching it: its page shows the home directory.

Bind a folder, start an agent in one of its tasks: the path above the terminal is the bound directory.
