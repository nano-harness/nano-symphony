/**
 * Example nano-symphony plan script.
 *
 * Copy this file, rename it, and dispatch it with spawn_plan_run or
 * spawn_plan_run_and_handoff. Add the reference line below for IDE support:
 *
 *   /// <reference path="./plan-runtime-globals.d.ts" />
 *   // @ts-check
 */

// @ts-check
/// <reference path="./plan-runtime-globals.d.ts" />

phase("Research");
const analysis = await issue(
  "Analyse the current auth module and summarise its pain points",
  {
    schema: {
      type: "object",
      properties: {
        pain_points: { type: "array", items: { type: "string" } },
      },
      required: ["pain_points"],
    },
  }
);

phase("Implement");
await parallel(
  analysis.pain_points.map((point) => () => issue(`Fix: ${point}`))
);

phase("Validate");
const report = await issue(
  "Run the test suite and report the result",
  {
    schema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["passed", "summary"],
    },
  }
);

log(`Validation passed: ${report.passed}`);
