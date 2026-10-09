import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { root, testCore } from "../../../test/helpers.ts";

it("local-dir: a new folder bound to ~ gets the home directory, another path stays as given", async () => {
  const core = await testCore({ pluginsDir: join(root, "plugins") });
  const rpc = (name: string, input: unknown) => core.plugins.loaded.get("local-dir")!.rpc.get(name)!(input);

  expect(rpc("check", { path: "~" })).toBe(homedir());
  expect(() => rpc("check", { path: join(root, "nope") })).toThrow(/Not a directory/);

  const home = core.store.createFolder({ name: "Home" });
  rpc("bind", { folderId: home.id, path: "~" });
  expect(core.store.folder(home.id)?.meta["local-dir"]).toEqual({ path: homedir() });

  const other = core.store.createFolder({ name: "Repo" });
  rpc("bind", { folderId: other.id, path: root });
  expect(core.store.folder(other.id)?.meta["local-dir"]).toEqual({ path: root });
});
