/** Parsed representation of a single log line */
export interface ParsedLogLine {
  /** Event type identifier, used for coloring and icon selection */
  type: "system" | "assistant" | "tool_call" | "tool_result" | "result" | "error" | "info" | "unknown";
  /** One-line summary text (displayed in list) */
  summary: string;
  /** Original raw line text */
  raw: string;
  /** Structured parsed data (pretty-printed when expanded) */
  parsed?: unknown;
  /** Optional timestamp */
  timestamp?: number;
  /** Whether to collapse by default (e.g. large init JSON) */
  defaultCollapsed?: boolean;
  /** Optional: merge key for combining related lines (e.g. hook_started + hook_response) */
  mergeKey?: string;
}

/** Each agent kind implements a LogLineParser */
export interface LogLineParser {
  /** Agent kind identifier, corresponds to backend AgentKind */
  kind: string;
  /** Parse a single raw text line into a structured result */
  parseLine(line: string): ParsedLogLine;
  /** Optional: post-process parsed lines (merge hook pairs, collapse consecutive system lines, etc.) */
  postProcess?(lines: ParsedLogLine[]): ParsedLogLine[];
}
