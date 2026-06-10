import { Database } from "bun:sqlite";
import sql from "./schema.sql" with { type: "text" };

export function runMigrations(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(sql);
}
