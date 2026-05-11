import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the app at https://<user>.github.io/Drand-Relay/, so
// production builds need the subpath baked in. Local dev still uses "/".
const base = process.env.GITHUB_PAGES === "1" ? "/Drand-Relay/" : "/";

export default defineConfig({
  base,
  plugins: [react()],
  define: {
    // Required for stellar-sdk in browser
    "process.env": {},
    global: "globalThis",
  },
});
