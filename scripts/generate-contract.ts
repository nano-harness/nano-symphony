#!/usr/bin/env bun
/**
 * Generate Go and TypeScript bindings from contract JSON schemas.
 *
 * Usage (run from nano-symphony root):
 *   bun scripts/generate-contract.ts
 *
 * Requires quicktype to be available via bunx.
 */
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SCHEMA_DIR = join(ROOT, "contract", "v1");
const TS_OUT_DIR = join(SCHEMA_DIR, "generated");
const GO_OUT_DIR = resolve(ROOT, "..", "nano-agent", "pkg", "contract", "v1");

const SCHEMAS = [
  "agent-result-summary.schema.json",
  "env.schema.json",
  "mcp-tools.schema.json",
];

function toPascalCase(kebab: string): string {
  return kebab
    .replace(/\.schema\.json$/, "")
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

async function generate() {
  mkdirSync(TS_OUT_DIR, { recursive: true });
  mkdirSync(GO_OUT_DIR, { recursive: true });

  for (const schema of SCHEMAS) {
    const schemaPath = join(SCHEMA_DIR, schema);
    if (!existsSync(schemaPath)) {
      console.warn(`Skipping missing schema: ${schemaPath}`);
      continue;
    }

    const base = basename(schema, ".schema.json");
    const pascal = toPascalCase(base);

    // TypeScript
    const tsOut = join(TS_OUT_DIR, `${base}.ts`);
    await $`bunx quicktype ${schemaPath} --src-lang schema --lang ts --out ${tsOut}`;
    let tsContent = await Bun.file(tsOut).text();
    tsContent = tsContent.replace(new RegExp(`\\b${pascal}\\b`, "g"), pascal);
    await Bun.write(tsOut, tsContent);
    console.log(`Generated ${tsOut}`);

    // Go
    const goOut = join(GO_OUT_DIR, `${base.replace(/-/g, "_")}.go`);
    await $`bunx quicktype ${schemaPath} --src-lang schema --lang go --out ${goOut}`;
    let goContent = await Bun.file(goOut).text();
    goContent = goContent.replace(/^package main$/m, "package contract");
    await Bun.write(goOut, goContent);
    console.log(`Generated ${goOut}`);
  }
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
