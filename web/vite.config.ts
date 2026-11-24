import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app lives in web/; `npm run dev` serves it here and proxies /api to
// the Hono server (src/server/main.ts), so both run as one origin in dev too.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
