import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Required for stellar-sdk in browser
    "process.env": {},
    global: "globalThis",
  },
});
