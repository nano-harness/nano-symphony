import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, screen } from "@solidjs/testing-library";
import { EventTimeline } from "../EventTimeline";
import type { SymphonyEvent } from "../api";

// Suppress real network calls from any async side effects.
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));

describe("EventTimeline", () => {
  beforeEach(() => {
    cleanup();
  });

  it("groups consecutive tool_call and tool_result by tool name", () => {
    const events: SymphonyEvent[] = [
      { id: "1", issue_uuid: "i", ts: 1000, kind: "tool_call", message: "Tool: Bash", payload_json: JSON.stringify({ tool: "Bash", input: "ls" }) },
      { id: "2", issue_uuid: "i", ts: 2000, kind: "tool_result", message: "Tool result: Bash", payload_json: JSON.stringify({ tool: "Bash", output: "file.txt", is_error: false }) },
    ];
    render(() => <EventTimeline events={events} />);
    expect(screen.getByText(/tool_call → tool_result/)).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("(1.0s)")).toBeTruthy();
  });

  it("shows error styling for failed tool results", () => {
    const events: SymphonyEvent[] = [
      { id: "1", issue_uuid: "i", ts: 1000, kind: "tool_call", message: "Tool: Bash", payload_json: JSON.stringify({ tool: "Bash" }) },
      { id: "2", issue_uuid: "i", ts: 2000, kind: "tool_result", message: "Tool result (error): Bash", payload_json: JSON.stringify({ tool: "Bash", is_error: true }) },
    ];
    const { container } = render(() => <EventTimeline events={events} />);
    expect(container.querySelector(".tool-pair.tool-error")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("renders attempt header when attempt changes", () => {
    const events: SymphonyEvent[] = [
      { id: "1", issue_uuid: "i", ts: 1000, kind: "started", message: "Attempt 1 started", payload_json: JSON.stringify({ attempt: 1 }) },
      { id: "2", issue_uuid: "i", ts: 2000, kind: "started", message: "Attempt 2 started", payload_json: JSON.stringify({ attempt: 2 }) },
    ];
    const { container } = render(() => <EventTimeline events={events} />);
    const headers = container.querySelectorAll(".event-attempt-label");
    expect(headers.length).toBe(2);
  });

  it("shows warm/hot delta labels based on elapsed time", () => {
    const events: SymphonyEvent[] = [
      { id: "1", issue_uuid: "i", ts: 1000, kind: "started", message: "start", payload_json: null },
      { id: "2", issue_uuid: "i", ts: 12_000, kind: "progress", message: "slow", payload_json: null },
      { id: "3", issue_uuid: "i", ts: 45_000, kind: "progress", message: "very slow", payload_json: null },
    ];
    const { container } = render(() => <EventTimeline events={events} />);
    const deltas = container.querySelectorAll(".event-delta");
    expect(deltas.length).toBe(3);
    expect(deltas[1].classList.contains("warm")).toBe(true);
    expect(deltas[2].classList.contains("hot")).toBe(true);
  });
});
