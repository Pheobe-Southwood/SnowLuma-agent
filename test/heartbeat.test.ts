import { describe, expect, it } from "vitest";
import { createWorkingHeartbeat, formatHeartbeat } from "../src/heartbeat.js";
import { defaultConfig, mergeConfig, validateConfig } from "../src/config.js";

describe("formatHeartbeat", () => {
  it("fills token and elapsed placeholders", () => {
    expect(formatHeartbeat("【工作中】目前已消耗{total}token", { input: 10, output: 5, total: 15 }, 65_000))
      .toBe("【工作中】目前已消耗15token");
    expect(formatHeartbeat("{input}/{output}/{total} {sessionTokens} {elapsed}", { input: 1, output: 2, total: 3 }, 500))
      .toBe("1/2/3 1/2/3 不到1秒");
  });
});

describe("createWorkingHeartbeat", () => {
  it("sends after silence reaches the interval and keeps sending while still silent", async () => {
    let now = 1_000;
    const sent: string[] = [];
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const hb = createWorkingHeartbeat({
      enabled: true,
      intervalMs: 30,
      template: "耗时{elapsed} 共{total}",
      getUsage: () => ({ input: 11, output: 4, total: 100 }),
      getElapsedMs: () => 2_000,
      isActive: () => true,
      send: async (text) => { sent.push(text); },
      now: () => now,
      setIntervalFn: ((fn: () => void) => {
        const id = nextId++;
        timers.set(id, fn);
        return id as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: ((id: NodeJS.Timeout) => {
        timers.delete(id as unknown as number);
      }) as typeof clearInterval,
    });

    now = 1_029;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toEqual([]);

    now = 1_030;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toEqual(["耗时2秒 共100"]);

    now = 1_060;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toEqual(["耗时2秒 共100", "耗时2秒 共100"]);

    hb.stop();
    now = 1_090;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toHaveLength(2);
  });

  it("resets silence when user-visible text is sent", async () => {
    let now = 0;
    const sent: string[] = [];
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const hb = createWorkingHeartbeat({
      enabled: true,
      intervalMs: 30,
      template: "ping {total}",
      getUsage: () => ({ input: 0, output: 0, total: 1 }),
      getElapsedMs: () => 0,
      isActive: () => true,
      send: async (text) => { sent.push(text); },
      now: () => now,
      setIntervalFn: ((fn: () => void) => {
        const id = nextId++;
        timers.set(id, fn);
        return id as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: ((id: NodeJS.Timeout) => {
        timers.delete(id as unknown as number);
      }) as typeof clearInterval,
    });

    now = 25;
    hb.onUserVisible();
    now = 30;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toEqual([]);

    now = 55;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toEqual(["ping 1"]);
    hb.stop();
  });

  it("does nothing when disabled or inactive", async () => {
    const sent: string[] = [];
    const disabled = createWorkingHeartbeat({
      enabled: false,
      intervalMs: 10,
      template: "x",
      getUsage: () => ({ input: 0, output: 0, total: 0 }),
      getElapsedMs: () => 0,
      isActive: () => true,
      send: async (text) => { sent.push(text); },
    });
    disabled.onUserVisible();
    disabled.stop();
    expect(sent).toEqual([]);

    let now = 0;
    let active = false;
    const timers = new Map<number, () => void>();
    const inactive = createWorkingHeartbeat({
      enabled: true,
      intervalMs: 10,
      template: "x",
      getUsage: () => ({ input: 0, output: 0, total: 0 }),
      getElapsedMs: () => 0,
      isActive: () => active,
      send: async (text) => { sent.push(text); },
      now: () => now,
      setIntervalFn: ((fn: () => void) => {
        timers.set(1, fn);
        return 1 as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: (() => { timers.clear(); }) as typeof clearInterval,
    });
    now = 20;
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(sent).toEqual([]);
    inactive.stop();
  });
});

describe("heartbeat config", () => {
  it("defaults to enabled 30s working notice", () => {
    const config = defaultConfig("/tmp/hb");
    expect(config.reply.heartbeatEnabled).toBe(true);
    expect(config.reply.heartbeatIntervalMs).toBe(30_000);
    expect(config.reply.heartbeatTemplate).toContain("{total}");
  });

  it("merges and validates heartbeat fields", () => {
    const merged = mergeConfig(defaultConfig("/tmp/hb"), {
      reply: { heartbeatEnabled: false, heartbeatIntervalMs: 5_000, heartbeatTemplate: "忙 {total}" },
    });
    expect(merged.reply.heartbeatEnabled).toBe(false);
    expect(merged.reply.heartbeatIntervalMs).toBe(5_000);
    expect(validateConfig(merged)).toEqual([]);

    const bad = mergeConfig(defaultConfig("/tmp/hb"), {
      reply: { heartbeatIntervalMs: 500, heartbeatTemplate: "   " },
    });
    const errors = validateConfig(bad);
    expect(errors.some((e) => e.includes("heartbeatIntervalMs"))).toBe(true);
    expect(errors.some((e) => e.includes("heartbeatTemplate"))).toBe(true);
  });
});
