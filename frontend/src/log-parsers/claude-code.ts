import type { LogLineParser, ParsedLogLine } from "./types";

export const claudeCodeParser: LogLineParser = {
  kind: "claude-code",

  parseLine(line: string): ParsedLogLine {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "--- log start ---") {
      return { type: "info", summary: trimmed || "(empty)", raw: line };
    }

    try {
      const obj = JSON.parse(trimmed);
      return parseClaudeCodeJson(obj, line);
    } catch {
      return { type: "unknown", summary: trimmed.slice(0, 120), raw: line };
    }
  },

  postProcess(lines: ParsedLogLine[]): ParsedLogLine[] {
    return mergeHookPairs(lines);
  },
};

function parseClaudeCodeJson(obj: Record<string, unknown>, raw: string): ParsedLogLine {
  const type = obj.type as string;

  switch (type) {
    case "system": {
      const sub = obj.subtype as string;
      if (sub === "init") {
        const tools = Array.isArray(obj.tools) ? obj.tools.length : 0;
        const model = obj.model ?? "unknown";
        return {
          type: "system",
          summary: `Session init — ${tools} tools, model: ${String(model)}`,
          raw,
          parsed: obj,
          defaultCollapsed: true,
        };
      }
      if (sub === "hook_started") {
        return {
          type: "system",
          summary: `Hook started: ${String(obj.hook_name ?? "")}`,
          raw,
          parsed: obj,
          mergeKey: obj.hook_id as string,
        };
      }
      if (sub === "hook_response") {
        return {
          type: "system",
          summary: `Hook ${String(obj.hook_name ?? "")} → ${String(obj.outcome ?? "")}`,
          raw,
          parsed: obj,
          mergeKey: obj.hook_id as string,
        };
      }
      return { type: "system", summary: `System: ${sub ?? ""}`, raw, parsed: obj };
    }

    case "assistant": {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        const text = content
          .map((c: Record<string, unknown>) => (c.text as string) ?? "")
          .filter(Boolean)
          .join("");
        if (text) {
          return { type: "assistant", summary: text.slice(0, 150), raw, parsed: obj };
        }
        const hasThinking = content.some((c: Record<string, unknown>) => "thinking" in c && c.thinking);
        if (hasThinking) {
          return { type: "assistant", summary: "(thinking...)", raw, parsed: obj, defaultCollapsed: true };
        }
      }
      return { type: "assistant", summary: "(assistant message)", raw, parsed: obj };
    }

    case "tool_use":
      return { type: "tool_call", summary: `Tool: ${String(obj.name ?? "unknown")}`, raw, parsed: obj };

    case "tool_result":
    case "user":
      return { type: "tool_result", summary: "(tool result)", raw, parsed: obj, defaultCollapsed: true };

    case "result": {
      const isError = obj.is_error as boolean;
      const result = (obj.result as string) ?? "";
      return {
        type: isError ? "error" : "result",
        summary: `${isError ? "ERROR" : "Completed"}: ${result.slice(0, 120)}`,
        raw,
        parsed: obj,
      };
    }

    default:
      return { type: "unknown", summary: `${type}: ${JSON.stringify(obj).slice(0, 100)}`, raw, parsed: obj };
  }
}

/** Merge consecutive hook_started + hook_response lines with the same mergeKey */
function mergeHookPairs(lines: ParsedLogLine[]): ParsedLogLine[] {
  const result: ParsedLogLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // If this is a hook_started and next is hook_response with same mergeKey, merge
    if (
      line.mergeKey &&
      i + 1 < lines.length &&
      lines[i + 1].mergeKey === line.mergeKey &&
      line.summary.startsWith("Hook started:")
    ) {
      result.push(lines[i + 1]); // Keep the response (it has the outcome)
      i++; // Skip next
    } else {
      result.push(line);
    }
  }
  return result;
}
