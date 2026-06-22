import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createHttpServer } from "../../src/http/server.ts";

async function importConfigModule() {
  // Cache-busting dynamic import so each test sees fresh env parsing.
  return import(`../../src/config.ts?bust=${Date.now()}`);
}

describe("config validation", () => {
  test("empty API_TOKEN is rejected at module load", async () => {
    const original = process.env.API_TOKEN;
    process.env.API_TOKEN = "";
    try {
      await expect(importConfigModule()).rejects.toThrow(/API_TOKEN/);
    } finally {
      process.env.API_TOKEN = original;
    }
  });

  test("non-loopback HOST without API_TOKEN rejects startup", async () => {
    const originalHost = process.env.HOST;
    const originalToken = process.env.API_TOKEN;
    delete process.env.API_TOKEN;
    process.env.HOST = "0.0.0.0";
    try {
      await expect(importConfigModule()).rejects.toThrow(/API_TOKEN/);
    } finally {
      process.env.HOST = originalHost;
      process.env.API_TOKEN = originalToken ?? "";
    }
  });

  test("loopback HOST without API_TOKEN is allowed", async () => {
    const originalHost = process.env.HOST;
    const originalToken = process.env.API_TOKEN;
    delete process.env.API_TOKEN;
    process.env.HOST = "127.0.0.1";
    try {
      await expect(importConfigModule()).resolves.toBeDefined();
    } finally {
      process.env.HOST = originalHost;
      process.env.API_TOKEN = originalToken ?? "";
    }
  });
});

describe("server auth with empty API_TOKEN", () => {
  test("createHttpServer treats empty apiToken as missing and generates one", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tracker = createTracker(db);
    const app = createHttpServer(tracker, () => undefined, () => {}, { apiToken: "" });
    // Empty string should behave like no token: server generates a random one,
    // so unauthenticated requests get 401.
    const res = await app.request("/api/v1/issues", { method: "GET" });
    expect(res.status).toBe(401);
  });
});
