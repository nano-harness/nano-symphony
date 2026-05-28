import type { LogLineParser, ParsedLogLine } from "./types";

export const nanoParser: LogLineParser = {
  kind: "nano",

  parseLine(line: string): ParsedLogLine {
    const trimmed = line.trim();
    if (!trimmed) return { type: "info", summary: "(empty)", raw: line };

    try {
      const obj = JSON.parse(trimmed);
      return parseNanoJson(obj, line);
    } catch {
      // nano may also output non-JSON plain text lines (e.g. binary exec stdout passthrough)
      return { type: "info", summary: trimmed.slice(0, 150), raw: line };
    }
  },
};

function parseNanoJson(obj: Record<string, unknown>, raw: string): ParsedLogLine {
  // nano-agent slog format: { time, level, msg, ...fields }
  const level = ((obj.level as string) ?? "").toUpperCase();
  const msg = (obj.msg as string) ?? "";
  const timestamp = obj.time ? new Date(obj.time as string).getTime() : undefined;

  if (msg.includes("tool_call") || msg.includes("executing tool")) {
    const tool = (obj.tool as string) ?? (obj.name as string) ?? "";
    return { type: "tool_call", summary: `Tool: ${tool || msg}`, raw, parsed: obj, timestamp };
  }
  if (msg.includes("assistant") || msg.includes("response")) {
    return { type: "assistant", summary: msg.slice(0, 150), raw, parsed: obj, timestamp };
  }
  if (level === "ERROR") {
    return { type: "error", summary: msg.slice(0, 150), raw, parsed: obj, timestamp };
  }
  if (msg.includes("result") || msg.includes("completed") || msg.includes("finished")) {
    return { type: "result", summary: msg.slice(0, 150), raw, parsed: obj, timestamp };
  }

  return {
    type: "system",
    summary: msg.slice(0, 150) || JSON.stringify(obj).slice(0, 100),
    raw,
    parsed: obj,
    timestamp,
  };
}
