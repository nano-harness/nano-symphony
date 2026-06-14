/**
 * CLI: validate a WORKFLOW.md file without starting the server.
 *
 * Usage:
 *   bun scripts/validate-workflow.ts [path/to/WORKFLOW.md]
 *
 * Defaults to the workflow path from config (WORKFLOW_PATH env or ./WORKFLOW.md).
 */

import { loadWorkflow } from "../src/workflow/loader.ts";
import { config } from "../src/config.ts";

const targetPath = process.argv[2] ?? config.WORKFLOW_PATH;

try {
  loadWorkflow(targetPath);
  console.log(`✓ ${targetPath} is valid`);
  process.exit(0);
} catch (err) {
  console.error(`✗ ${targetPath} is invalid`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
