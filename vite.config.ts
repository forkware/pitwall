import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: `${root}src/ui`,
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: [root] } },
  build: { outDir: `${root}dist/ui`, emptyOutDir: true },
});
