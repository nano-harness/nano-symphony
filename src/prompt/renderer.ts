import { Liquid } from "liquidjs";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export interface RenderPromptOptions {
  goal?: {
    condition: string;
    inject_mode?: "prefix" | "system" | "none";
  };
}

export async function renderPrompt(
  template: string,
  vars: Record<string, unknown>,
  opts: RenderPromptOptions = {}
): Promise<string> {
  const rendered = await engine.parseAndRender(template, vars);
  if (opts.goal?.condition && (opts.goal.inject_mode ?? "prefix") === "prefix") {
    return `/goal ${opts.goal.condition}\n\n${rendered}`;
  }
  return rendered;
}
