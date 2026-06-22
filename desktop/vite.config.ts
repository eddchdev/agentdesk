import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, "ui"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist-ui"),
    emptyOutDir: true,
    target: "chrome128",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
