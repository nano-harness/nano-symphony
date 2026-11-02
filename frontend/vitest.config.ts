import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid({ dev: true, ssr: false })],
  resolve: {
    conditions: ["development", "browser"],
    alias: {
      "solid-js/web": "solid-js/web/dist/dev.js",
      "solid-js/store": "solid-js/store/dist/dev.js",
      "solid-js": "solid-js/dist/dev.js",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.{test,vitest}.{ts,tsx}"],
  },
});
