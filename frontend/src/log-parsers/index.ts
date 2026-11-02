import type { LogLineParser, ParsedLogLine } from "./types";
import { claudeCodeParser } from "./claude-code";
import { nanoParser } from "./nano";

const PARSERS = new Map<string, LogLineParser>([
  ["claude-code", claudeCodeParser],
  ["nano", nanoParser],
]);

/** Get the parser for a given agent kind, falling back to a generic parser */
export function getLogParser(agentKind: string | null | undefined): LogLineParser {
  if (agentKind && PARSERS.has(agentKind)) {
    return PARSERS.get(agentKind)!;
  }
  return fallbackParser;
}

/** Generic fallback: display lines as-is, attempt JSON pretty-print */
const fallbackParser: LogLineParser = {
  kind: "fallback",
  parseLine(line: string): ParsedLogLine {
    const trimmed = line.trim();
    if (!trimmed) return { type: "info", summary: "(empty)", raw: line };
    try {
      const obj = JSON.parse(trimmed);
      const type = (obj.type as string) ?? "unknown";
      return { type: "unknown", summary: `${type}: ${trimmed.slice(0, 100)}`, raw: line, parsed: obj };
    } catch {
      return { type: "info", summary: trimmed.slice(0, 150), raw: line };
    }
  },
};

export type { LogLineParser, ParsedLogLine } from "./types";
