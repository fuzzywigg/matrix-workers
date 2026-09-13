/**
 * Minimal Durable Object runtime stand-ins for Vitest (node).
 * Mirrors the CallRoom hibernation FakeStorage pattern; shared so DO suites
 * can exercise fetch routing without cloudflare:workers.
 */

export class FakeStorage {
  map = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  async list<T>(options: { prefix: string; limit?: number } = { prefix: '' }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.map.entries()].sort()) {
      if (k.startsWith(options.prefix)) {
        out.set(k, v as T);
        if (options.limit !== undefined && out.size >= options.limit) break;
      }
    }
    return out;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

export class FakeWebSocket {
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  tags: string[] = [];

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

export class FakeDurableObjectState {
  storage = new FakeStorage();
  sockets: FakeWebSocket[] = [];

  getWebSockets(): FakeWebSocket[] {
    return this.sockets;
  }

  acceptWebSocket(ws: FakeWebSocket, tags?: string[]): void {
    if (tags) ws.tags = tags;
    this.sockets.push(ws);
  }

  setWebSocketAutoResponse(): void {}

  blockConcurrencyWhile(cb: () => Promise<void>): Promise<void> {
    return cb();
  }
}

/** Vitest mock factory for `cloudflare:workers` DurableObject base. */
export function durableObjectMockFactory() {
  return {
    DurableObject: class {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
}
