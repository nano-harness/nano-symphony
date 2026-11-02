import { describe, it, expect } from "bun:test";
import { Semaphore } from "../../src/orchestrator/index.ts";

describe("concurrency semaphore", () => {
  it("tracks available and active slots", () => {
    const sem = new Semaphore(3);
    expect(sem.status()).toEqual({ limit: 3, available: 3, active: 0 });
    sem.acquire();
    expect(sem.status()).toEqual({ limit: 3, available: 2, active: 1 });
    sem.release();
    expect(sem.status()).toEqual({ limit: 3, available: 3, active: 0 });
  });

  it("queues acquires when at capacity", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let acquired = false;
    const pending = sem.acquire().then(() => { acquired = true; });
    await new Promise((res) => setTimeout(res, 10));
    expect(acquired).toBe(false);
    sem.release();
    await pending;
    expect(acquired).toBe(true);
  });

  it("adjusts capacity dynamically", () => {
    const sem = new Semaphore(2);
    sem.acquire();
    expect(sem.status().available).toBe(1);
    sem.setMax(3);
    expect(sem.status()).toEqual({ limit: 3, available: 2, active: 1 });
    sem.setMax(1);
    expect(sem.status()).toEqual({ limit: 1, available: 0, active: 1 });
    sem.release();
    expect(sem.status()).toEqual({ limit: 1, available: 1, active: 0 });
  });

  it("does not allow capacity below 1", () => {
    const sem = new Semaphore(1);
    sem.setMax(0);
    expect(sem.status().limit).toBe(1);
  });
});
