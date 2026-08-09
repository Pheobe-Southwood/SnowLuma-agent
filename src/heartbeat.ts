import { formatDuration, formatTokens } from "./status.js";

export interface HeartbeatUsage {
  input: number;
  output: number;
  total: number;
}

export function formatHeartbeat(template: string, usage: HeartbeatUsage, elapsedMs: number): string {
  const map: Record<string, string> = {
    total: String(usage.total),
    input: String(usage.input),
    output: String(usage.output),
    sessionTokens: formatTokens(usage.input, usage.output, usage.total),
    elapsed: formatDuration(elapsedMs),
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in map ? map[key] : match));
}

export interface WorkingHeartbeat {
  onUserVisible(): void;
  stop(): void;
}

export function createWorkingHeartbeat(options: {
  enabled: boolean;
  intervalMs: number;
  template: string;
  getUsage: () => HeartbeatUsage;
  getElapsedMs: () => number;
  isActive: () => boolean;
  send: (text: string) => Promise<void>;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): WorkingHeartbeat {
  if (!options.enabled) return { onUserVisible() {}, stop() {} };
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let lastVisibleAt = now();
  let stopped = false;
  let sending = false;
  const timer = setIntervalFn(() => {
    void tick();
  }, options.intervalMs);

  async function tick(): Promise<void> {
    if (stopped || sending || !options.isActive()) return;
    if (now() - lastVisibleAt < options.intervalMs) return;
    sending = true;
    try {
      const text = formatHeartbeat(options.template, options.getUsage(), options.getElapsedMs());
      if (text) await options.send(text);
    } catch {
      // sendText already retries; ignore residual errors so the agent loop keeps running
    } finally {
      sending = false;
    }
  }

  return {
    onUserVisible() {
      lastVisibleAt = now();
    },
    stop() {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
