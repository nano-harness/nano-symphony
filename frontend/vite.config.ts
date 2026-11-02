import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
export default defineConfig({ plugins: [solid()], server: { proxy: { "/api": "http://localhost:4123", "/mcp": "http://localhost:4123" } }, build: { outDir: "dist" } });
