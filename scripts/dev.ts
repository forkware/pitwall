// `pnpm run dev`: this app as a web server on $PORT with data of its own, for trying a change: the development
// process's dev stand. It runs inside the app you work in, so it drops what that app passes to its children.
import { join } from "node:path";

for (const key of ["PITWALL_SERVER_CHILD", "PITWALL_TOKEN", "PITWALL_DATA_DIR", "PITWALL_SETTINGS", "PITWALL_URL"]) delete process.env[key];
process.argv.push("--server", "--data-dir", join(import.meta.dirname, "..", ".dev-data"));
if (process.env.PORT) process.argv.push("--port", process.env.PORT);
await import("../src/cli.ts");
