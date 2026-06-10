import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { bus } from "./event_bus.ts";
import type { SymphonyEvent } from "./tracker-types.ts";
export type { EventKind } from "./event-kinds.ts";

export function createEventOps(db: Database) {
  const recordEventStmt = db.prepare(`
    INSERT INTO symphony_events (id, issue_uuid, ts, kind, message, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getEventsSinceStmt = db.prepare(`
    SELECT * FROM symphony_events WHERE ts > ? ORDER BY ts ASC
  `);

  const getAllEventsStmt = db.prepare(`
    SELECT * FROM symphony_events ORDER BY ts ASC
  `);

  const getLatestEventByKindStmt = db.prepare(`
    SELECT * FROM symphony_events
    WHERE issue_uuid = ? AND kind = ?
    -- Multiple events can share a millisecond timestamp; rowid keeps "latest" deterministic.
    ORDER BY ts DESC, rowid DESC
    LIMIT 1
  `);

  const getEventsByKindStmt = db.prepare(`
    SELECT * FROM symphony_events
    WHERE issue_uuid = ? AND kind = ?
    ORDER BY ts ASC, rowid ASC
  `);

  /**
   * Records an event for an issue.
   *
   * Payload convention for frontend rendering:
   * - `payload.markdown?: string` — primary field rendered as markdown in the UI
   * - Also recognized: `payload.text`, `payload.summary`, `payload.message`,
   *   `payload.content`, `payload.reason` (in priority order)
   * - If none of these fields are present, the entire payload is shown as JSON
   */
  function recordEvent(issueUuid: string, kind: string, message: string, payload?: unknown): void {
    const id = nanoid();
    const ts = Date.now();
    const payloadJson = payload !== undefined ? JSON.stringify(payload) : null;
    recordEventStmt.run(id, issueUuid, ts, kind, message, payloadJson);
    // Emit event on bus after DB write succeeds
    bus.emit("event", { id, issue_uuid: issueUuid, ts, kind, message, payload_json: payloadJson });
  }

  function getEvents(since?: number): SymphonyEvent[] {
    if (since !== undefined) {
      return getEventsSinceStmt.all(since) as SymphonyEvent[];
    }
    return getAllEventsStmt.all() as SymphonyEvent[];
  }

  function getLatestEventByKind(issueUuid: string, kind: string): SymphonyEvent | null {
    return (getLatestEventByKindStmt.get(issueUuid, kind) as SymphonyEvent | null) ?? null;
  }

  function getEventsByKind(issueUuid: string, kind: string): SymphonyEvent[] {
    return getEventsByKindStmt.all(issueUuid, kind) as SymphonyEvent[];
  }

  return {
    recordEvent,
    getEvents,
    getLatestEventByKind,
    getEventsByKind,
  };
}
