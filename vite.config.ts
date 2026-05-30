import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative base so the dist is portable to any subpath (GitHub Pages,
  // Cloudflare Pages, or any nested folder on a static host). Runtime asset
  // paths in code must use `import.meta.env.BASE_URL` to stay consistent.
  base: "./",
  plugins: [react()],
  server: {
    host: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          mediapipe: ["@mediapipe/tasks-vision"],
          three: ["three"],
        },
      },
    },
  },
});
