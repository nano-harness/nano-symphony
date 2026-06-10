import { existsSync } from "fs";
import { join, resolve } from "path";

function findShareRoot(): string {
  if (process.env.SYMPHONY_SHARE_ROOT) return resolve(process.env.SYMPHONY_SHARE_ROOT);
  const cwdShare = join(process.cwd(), "share");
  if (existsSync(join(cwdShare, "frontend", "dist", "index.html"))) return cwdShare;
  console.error(
    "[paths] share/ not found. Set SYMPHONY_SHARE_ROOT to the directory that contains share/frontend/dist/index.html, or run from the installation directory."
  );
  process.exit(1);
}

export const SHARE_ROOT = findShareRoot();
export const FRONTEND_DIST = join(SHARE_ROOT, "frontend", "dist");
export const SKILLS_DIR = join(SHARE_ROOT, "skills", "nano-symphony");
export const WORKFLOW_TEMPLATE = join(SHARE_ROOT, "templates", "WORKFLOW.example.md");
