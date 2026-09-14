/**
 * TOKENMAXX HEAVY leftovers after #226 — federation-catchup / federation-consumer /
 * federation-device-list *concurrent race / TOCTOU* + send-route method leftovers.
 *
 * Complements existing files (not re-flooding their serial coverage):
 *   - federation-catchup-workflow.test.ts + leftovers (#171)
 *   - federation-media-compaction-workflow-concurrent-race (#195 Promise.all isolation)
 *   - federation-consumer.test.ts (serial ack/retry/sign — zero Promise.all)
 *   - federation-device-list-edu-deepen.test.ts (serial add/delete/stream)
 *   - federation-api-concurrent-race (#219 empty-pdu send cache TOCTOU)
 *
 * Distinct edges: catchup fetch/D1 barriers + version ok∥fail; consumer batch
 * isolation / dest grouping / backoff under race; inbound m.device_list_update
 * add∥delete / stream MAX / write-barrier last-write-win; PUT send method matrix.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const FED_ORIGIN = 'remote.example.com';
let federationOrigin: string | undefined = FED_ORIGIN;

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOrigin !== undefined) {
        c.set('federationOrigin', federationOrigin);
      }
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOrigin !== undefined) {
        c.set('federationOrigin', federationOrigin);
      }
      await next();
    };
  },
}));

vi.mock('../src/services/federation-keys', () => ({
  getRemoteKeysWithNotarySignature: vi.fn(),
  verifyRemoteSignature: vi.fn(async () => true),
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getRoomState: vi.fn(async () => ({})),
  };
});

vi.mock('../src/services/event-auth', () => ({
  checkEventAuth: vi.fn(() => ({ allowed: true })),
}));

import { FederationCatchupWorkflow } from '../src/workflows/FederationCatchupWorkflow';
import { handleFederationQueue } from '../src/consumers/federation-consumer';
import federation from '../src/api/federation';

const NOW = 1_700_000_000_000;
const REMOTE = 'remote.example.com';
const PEER = 'peer.example.com';
const SERVER = 'example.com';
const REMOTE_USER = '@bob:remote.example.com';
const REMOTE_USER_B = '@carol:remote.example.com';
const REMOTE_DEVICE = 'REMOTEDEV';
const REMOTE_DEVICE_B = 'REMOTEDEVB';

type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type SqlCall = { sql: string; args: unknown[] };

async function withSqlBarrier(
  barrier: SqlBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function createNBarrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= n) release();
      await gate;
    },
    get arrived() {
      return arrived;
    },
  };
}

function mockStep() {
  const names: string[] = [];
  return {
    names,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function createCatchupEnv(opts: {
  latestByRoom?: Record<string, string | null | undefined>;
  throwRooms?: Set<string>;
  selectBarrier?: SqlBarrier;
  mutateLatestAfterBarrier?: Record<string, string | null>;
}) {
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  const latestByRoom = { ...(opts.latestByRoom ?? {}) };
  const firstCalls: SqlCall[] = [];
  return {
    firstCalls,
    latestByRoom,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                firstCalls.push({ sql, args });
                await withSqlBarrier(selectBarrier, waiters, () => {
                  selectBarrier = undefined;
                  if (opts.mutateLatestAfterBarrier) {
                    Object.assign(latestByRoom, opts.mutateLatestAfterBarrier);
                  }
                }, sql, args);
                if (sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering')) {
                  const roomId = args[0] as string;
                  if (opts.throwRooms?.has(roomId)) throw new Error(`d1 boom ${roomId}`);
                  const id = latestByRoom[roomId];
                  if (id === undefined || id === null) return null;
                  return { event_id: id } as T;
                }
                return null;
              },
            };
          },
        };
      },
    },
  };
}

type QueueBody = {
  destination: string;
  pdu?: Record<string, unknown>;
  edu?: { edu_type: string; content: Record<string, unknown> };
  timestamp: number;
};

function makeMessage(body: QueueBody, attempts = 0) {
  return {
    body,
    attempts,
    retry: vi.fn(),
    ack: vi.fn(),
  };
}

function makeConsumerDb(opts: {
  row?: { key_id: string; private_key_jwk: string | null } | null;
  selectBarrier?: SqlBarrier;
  throwOnKey?: boolean;
} = {}) {
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  const firstCalls: SqlCall[] = [];
  return {
    firstCalls,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              firstCalls.push({ sql, args });
              await withSqlBarrier(selectBarrier, waiters, () => {
                selectBarrier = undefined;
              }, sql, args);
              if (opts.throwOnKey) throw new Error('d1 key boom');
              return (opts.row ?? null) as T;
            },
          };
        },
        first: async () => {
          firstCalls.push({ sql, args: [] });
          await withSqlBarrier(selectBarrier, waiters, () => {
            selectBarrier = undefined;
          }, sql, []);
          if (opts.throwOnKey) throw new Error('d1 key boom');
          return opts.row ?? null;
        },
      };
    },
  } as unknown as Env['DB'] & { firstCalls: SqlCall[] };
}

type RemoteDeviceRow = {
  user_id: string;
  device_id: string;
  device_display_name: string | null;
  keys: string | null;
  stream_id: number;
  updated_at: number;
};

type RemoteStreamRow = {
  user_id: string;
  stream_id: number;
  updated_at: number;
};

function deviceKey(userId: string, deviceId: string) {
  return `${userId}|${deviceId}`;
}

function createDeviceListDb(opts: {
  remoteDevices?: RemoteDeviceRow[];
  remoteStreams?: RemoteStreamRow[];
  federationTxns?: Record<string, string>;
  selectBarrier?: SqlBarrier;
  writeBarrier?: SqlBarrier;
  failRemoteDeviceLists?: boolean;
} = {}) {
  const remoteDevices = new Map<string, RemoteDeviceRow>(
    (opts.remoteDevices ?? []).map((r) => [deviceKey(r.user_id, r.device_id), { ...r }])
  );
  const remoteStreams = new Map<string, RemoteStreamRow>(
    (opts.remoteStreams ?? []).map((r) => [r.user_id, { ...r }])
  );
  const federationTxns: Record<string, string> = { ...(opts.federationTxns ?? {}) };
  const processedEdus: Array<{ edu_id: string; edu_type: string; origin: string }> = [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const firstCalls: SqlCall[] = [];
  const selectWaiters = { list: [] as Array<() => void> };
  const writeWaiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  let writeBarrier = opts.writeBarrier;

  const db = {
    remoteDevices,
    remoteStreams,
    federationTxns,
    processedEdus,
    inserts,
    deletes,
    firstCalls,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              firstCalls.push({ sql, args });
              await withSqlBarrier(selectBarrier, selectWaiters, () => {
                selectBarrier = undefined;
              }, sql, args);
              if (sql.includes('SELECT response FROM federation_transactions')) {
                const [txnId, origin] = args as [string, string];
                const raw = federationTxns[`${origin}|${txnId}`];
                return (raw ? { response: raw } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              await withSqlBarrier(writeBarrier, writeWaiters, () => {
                writeBarrier = undefined;
              }, sql, args);

              if (
                opts.failRemoteDeviceLists &&
                (sql.includes('DELETE FROM remote_device_lists') ||
                  (sql.includes('INSERT') && sql.includes('remote_device_lists')))
              ) {
                throw new Error('simulated remote_device_lists failure');
              }

              if (sql.includes('DELETE FROM remote_device_lists')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as [string, string];
                remoteDevices.delete(deviceKey(userId, deviceId));
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('INSERT') && sql.includes('remote_device_lists')) {
                inserts.push({ sql, args });
                const [userId, deviceId, displayName, keys, streamId, updatedAt] = args as [
                  string,
                  string,
                  string | null,
                  string | null,
                  number,
                  number,
                ];
                remoteDevices.set(deviceKey(userId, deviceId), {
                  user_id: userId,
                  device_id: deviceId,
                  device_display_name: displayName,
                  keys,
                  stream_id: streamId,
                  updated_at: updatedAt,
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('INSERT') && sql.includes('remote_device_list_streams')) {
                inserts.push({ sql, args });
                const [userId, streamId, updatedAt] = args as [string, number, number];
                const prev = remoteStreams.get(userId);
                const nextStream = prev ? Math.max(prev.stream_id, streamId) : streamId;
                remoteStreams.set(userId, {
                  user_id: userId,
                  stream_id: nextStream,
                  updated_at: updatedAt,
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('processed_edus')) {
                inserts.push({ sql, args });
                const [eduId, eduType, origin] = args as [string, string, string];
                processedEdus.push({ edu_id: eduId, edu_type: eduType, origin });
                return { success: true, meta: { changes: 1 } };
              }

              if (
                sql.includes('INSERT INTO federation_transactions') ||
                sql.includes('INSERT OR REPLACE INTO federation_transactions')
              ) {
                inserts.push({ sql, args });
                const [txnId, origin, , response] = args as [string, string, number, string];
                federationTxns[`${origin}|${txnId}`] = response;
                return { success: true, meta: { changes: 1 } };
              }

              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type DeviceListDb = ReturnType<typeof createDeviceListDb>;

function makeEnv(db: DeviceListDb): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: db as unknown as D1Database,
  } as Env;
}

async function sendTxn(
  env: Env,
  txnId: string,
  body: unknown,
  method: string = 'PUT'
): Promise<{ status: number; body: unknown }> {
  const res = await federation.request(
    `http://localhost/_matrix/federation/v1/send/${txnId}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:
        method === 'GET' || method === 'HEAD' || method === 'DELETE'
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function deviceListEdu(content: Record<string, unknown>) {
  return { edu_type: 'm.device_list_update', content };
}

async function runCatchup(
  env: { DB: D1Database },
  serverName: string,
  roomIds: string[]
) {
  const wf = new FederationCatchupWorkflow({} as never, env as never);
  const step = mockStep();
  const result = await wf.run({ payload: { serverName, roomIds } } as never, step as never);
  return { result, step };
}

// ---------------------------------------------------------------------------
// Catchup concurrent-race leftovers
// ---------------------------------------------------------------------------

describe('federation-catchup concurrent-race leftovers after #226', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('version ok∥fail isolation under Promise.all keyed by host', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes(`https://${REMOTE}/_matrix/federation/v1/version`)) {
        return new Response('ok', { status: 200 });
      }
      if (u.includes(`https://${PEER}/_matrix/federation/v1/version`)) {
        return new Response('down', { status: 503 });
      }
      if (u.includes('get_missing_events')) {
        return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    });
    const room = '!r:example.com';
    const envOk = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
    const envFail = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
    const [ok, fail] = await Promise.all([
      runCatchup(envOk as never, REMOTE, [room]),
      runCatchup(envFail as never, PEER, [room]),
    ]);
    expect(ok.result).toEqual({ serverName: REMOTE, backfilledEvents: 2, success: true });
    expect(fail.result).toEqual({
      serverName: PEER,
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    });
    expect(ok.step.names).toEqual(['check-server', `backfill-${room}`]);
    expect(fail.step.names).toEqual(['check-server']);
  });

  it('version fetch barrier: both in-flight then 200∥404', async () => {
    const gate = createNBarrier(2);
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/version')) {
        await gate.wait();
        if (u.includes(REMOTE)) return new Response('ok', { status: 200 });
        return new Response('missing', { status: 404 });
      }
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const room = '!g:example.com';
    const [a, b] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$a' } }) as never,
        REMOTE,
        [room]
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$b' } }) as never,
        PEER,
        [room]
      ),
    ]);
    expect(gate.arrived).toBe(2);
    expect(a.result.success).toBe(true);
    expect(a.result.backfilledEvents).toBe(1);
    expect(b.result.success).toBe(false);
    expect(b.result.error).toBe('Server not reachable');
  });

  it('same-room concurrent workflows both POST get_missing_events independently', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/version')) return new Response('ok', { status: 200 });
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      return new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 });
    });
    const room = '!same:example.com';
    const env = createCatchupEnv({ latestByRoom: { [room]: '$shared:example.com' } });
    const [a, b] = await Promise.all([
      runCatchup(env as never, REMOTE, [room]),
      runCatchup(env as never, REMOTE, [room]),
    ]);
    expect(a.result.backfilledEvents).toBe(3);
    expect(b.result.backfilledEvents).toBe(3);
    const backfills = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('get_missing_events')
    );
    expect(backfills).toHaveLength(2);
    expect(String(backfills[0][0])).toBe(
      `https://${REMOTE}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(room)}`
    );
  });

  it('latest-event D1 SELECT barrier TOCTOU mutates earliest_events after both wait', async () => {
    const room = '!toc:example.com';
    const posted: string[][] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      posted.push(JSON.parse(String(init?.body)).earliest_events);
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const env = createCatchupEnv({
      latestByRoom: { [room]: '$old:example.com' },
      selectBarrier: {
        match: (sql) => sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering'),
        count: 2,
      },
      mutateLatestAfterBarrier: { [room]: '$new:example.com' },
    });
    const [a, b] = await Promise.all([
      runCatchup(env as never, REMOTE, [room]),
      runCatchup(env as never, REMOTE, [room]),
    ]);
    expect(a.result.success).toBe(true);
    expect(b.result.success).toBe(true);
    expect(posted).toEqual([['$new:example.com'], ['$new:example.com']]);
  });

  it('empty roomIds ∥ populated isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const room = '!p:example.com';
    const [empty, filled] = await Promise.all([
      runCatchup(createCatchupEnv({}) as never, REMOTE, []),
      runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never,
        PEER,
        [room]
      ),
    ]);
    expect(empty.result).toEqual({ serverName: REMOTE, backfilledEvents: 0, success: true });
    expect(filled.result.backfilledEvents).toBe(2);
  });

  it('version throw ∥ 200 isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes(`${REMOTE}/`) && u.includes('/version')) {
        throw new Error('dns');
      }
      if (u.includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const room = '!t:example.com';
    const [thrown, ok] = await Promise.all([
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never, REMOTE, [room]),
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never, PEER, [room]),
    ]);
    expect(thrown.result.error).toBe('Server not reachable');
    expect(ok.result.success).toBe(true);
  });

  it('encoded room ids concurrent URL isolation', async () => {
    const rooms = ['!a/b:example.com', '!a b:example.com'];
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    await Promise.all(
      rooms.map((room) =>
        runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: '$x' } }) as never,
          REMOTE,
          [room]
        )
      )
    );
    const urls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('get_missing_events'));
    expect(urls.sort()).toEqual(
      rooms
        .map(
          (r) =>
            `https://${REMOTE}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(r)}`
        )
        .sort()
    );
  });

  it('AbortSignal.timeout wiring isolated per concurrent run', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a', '!b:example.com': '$b' } }) as never,
        REMOTE,
        ['!a:example.com', '!b:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!c:example.com': '$c' } }) as never,
        PEER,
        ['!c:example.com']
      ),
    ]);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 10_000)).toHaveLength(2);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 30_000)).toHaveLength(3);
  });

  it('D1 throw room zeros that run; sibling workflow still aggregates', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}, {}, {}, {}] }), { status: 200 });
    });
    const bad = '!bad:example.com';
    const good = '!good:example.com';
    const [thrown, ok] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { [bad]: '$x' }, throwRooms: new Set([bad]) }) as never,
        REMOTE,
        [bad]
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { [good]: '$y' } }) as never,
        PEER,
        [good]
      ),
    ]);
    expect(thrown.result.backfilledEvents).toBe(0);
    expect(thrown.result.success).toBe(true);
    expect(ok.result.backfilledEvents).toBe(4);
  });

  it('get_missing_events POST body pins limit/earliest/latest under race', async () => {
    const bodies: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!b:example.com': '$b' } }) as never,
        PEER,
        ['!b:example.com']
      ),
    ]);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { limit: 100, earliest_events: ['$a'], latest_events: [] },
        { limit: 100, earliest_events: ['$b'], latest_events: [] },
      ])
    );
  });

  for (const status of [201, 202, 204] as const) {
    it(`version HTTP ${status} (ok) ∥ 429 isolation`, async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes(`${REMOTE}/`) && u.includes('/version')) {
          return new Response(null, { status });
        }
        if (u.includes('/version')) return new Response('limited', { status: 429 });
        return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
      });
      const room = `!ok${status}:example.com`;
      const [ok, limited] = await Promise.all([
        runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never,
          REMOTE,
          [room]
        ),
        runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never,
          PEER,
          [room]
        ),
      ]);
      expect(ok.result.success).toBe(true);
      expect(limited.result.error).toBe('Server not reachable');
    });
  }

  it('eight remotes concurrent isolation soft flood', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/version')) {
        return u.includes('down')
          ? new Response('no', { status: 503 })
          : new Response('ok', { status: 200 });
      }
      const match = /get_missing_events\/([^?]+)/.exec(u);
      const room = match ? decodeURIComponent(match[1]) : '';
      const n = Number(room.replace(/[^0-9]/g, '')) || 1;
      return new Response(JSON.stringify({ events: Array.from({ length: n }, () => ({})) }), {
        status: 200,
      });
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const host = i % 2 === 0 ? `ok${i}.example.com` : `down${i}.example.com`;
        const room = `!r${i + 1}:example.com`;
        return runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: `$${i}` } }) as never,
          host,
          [room]
        );
      })
    );
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) {
        expect(results[i].result.success).toBe(true);
        expect(results[i].result.backfilledEvents).toBe(i + 1);
      } else {
        expect(results[i].result.success).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Consumer concurrent-race leftovers
// ---------------------------------------------------------------------------

describe('federation-consumer concurrent-race leftovers after #226', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('two batches same dest concurrent both PUT and ack independently', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const a = makeMessage({ destination: 'a.example.com', pdu: { event_id: '$1' }, timestamp: NOW });
    const b = makeMessage({ destination: 'a.example.com', pdu: { event_id: '$2' }, timestamp: NOW });
    const env = { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env;
    await Promise.all([
      handleFederationQueue({ messages: [a] } as unknown as MessageBatch<QueueBody>, env),
      handleFederationQueue({ messages: [b] } as unknown as MessageBatch<QueueBody>, env),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.startsWith('https://a.example.com/_matrix/federation/v1/send/'))).toBe(
      true
    );
  });

  it('ok∥fail dest isolation across concurrent batches', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('ok.example.com')) return new Response('{}', { status: 200 });
      return new Response('down', { status: 503 });
    });
    const okMsg = makeMessage({
      destination: 'ok.example.com',
      pdu: { event_id: '$ok' },
      timestamp: NOW,
    });
    const failMsg = makeMessage(
      { destination: 'fail.example.com', pdu: { event_id: '$f' }, timestamp: NOW },
      0
    );
    await Promise.all([
      handleFederationQueue(
        { messages: [okMsg] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [failMsg] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(okMsg.ack).toHaveBeenCalledOnce();
    expect(okMsg.retry).not.toHaveBeenCalled();
    expect(failMsg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(failMsg.ack).not.toHaveBeenCalled();
  });

  it('fetch barrier both dest sends in-flight then 200∥throw', async () => {
    const gate = createNBarrier(2);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      await gate.wait();
      if (String(url).includes('ok.example.com')) return new Response('{}', { status: 200 });
      throw new Error('offline');
    });
    const okMsg = makeMessage({
      destination: 'ok.example.com',
      pdu: { event_id: '$ok' },
      timestamp: NOW,
    });
    const failMsg = makeMessage(
      { destination: 'throw.example.com', pdu: { event_id: '$t' }, timestamp: NOW },
      2
    );
    await Promise.all([
      handleFederationQueue(
        { messages: [okMsg] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [failMsg] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(gate.arrived).toBe(2);
    expect(okMsg.ack).toHaveBeenCalledOnce();
    expect(failMsg.retry).toHaveBeenCalledWith({ delaySeconds: Math.pow(2, 2) * 60 });
  });

  it('empty batch ∥ populated isolation (empty never fetch)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const msg = makeMessage({
      destination: 'p.example.com',
      pdu: { event_id: '$p' },
      timestamp: NOW,
    });
    await Promise.all([
      handleFederationQueue(
        { messages: [] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [msg] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('attempts 4 retry ∥ attempts 5 ack concurrent', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 500 })
    );
    const at4 = makeMessage(
      { destination: 'r.example.com', pdu: { event_id: '$4' }, timestamp: NOW },
      4
    );
    const at5 = makeMessage(
      { destination: 'r.example.com', pdu: { event_id: '$5' }, timestamp: NOW },
      5
    );
    await Promise.all([
      handleFederationQueue(
        { messages: [at4] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [at5] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(at4.retry).toHaveBeenCalledWith({ delaySeconds: 16 * 60 });
    expect(at5.ack).toHaveBeenCalledOnce();
    expect(at5.retry).not.toHaveBeenCalled();
  });

  it('pdu+edu grouping in one batch ∥ pdu-only concurrent batch', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const mixed1 = makeMessage({
      destination: 'mix.example.com',
      pdu: { event_id: '$p' },
      timestamp: NOW,
    });
    const mixed2 = makeMessage({
      destination: 'mix.example.com',
      edu: { edu_type: 'm.typing', content: { room_id: '!r:example.com' } },
      timestamp: NOW,
    });
    const only = makeMessage({
      destination: 'only.example.com',
      pdu: { event_id: '$o' },
      timestamp: NOW,
    });
    await Promise.all([
      handleFederationQueue(
        { messages: [mixed1, mixed2] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [only] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const byHost = Object.fromEntries(
      fetchMock.mock.calls.map((c) => [new URL(String(c[0])).host, JSON.parse(String(c[1]?.body))])
    );
    expect(byHost['mix.example.com']).toMatchObject({
      pdus: [{ event_id: '$p' }],
      edus: [{ edu_type: 'm.typing', content: { room_id: '!r:example.com' } }],
      origin: 'local.example.com',
      origin_server_ts: NOW,
    });
    expect(byHost['only.example.com']).toMatchObject({
      pdus: [{ event_id: '$o' }],
      edus: [],
    });
  });

  it('signing-key SELECT barrier: concurrent dests share one first() wait then both unsigned', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const db = makeConsumerDb({
      row: { key_id: 'ed25519:null', private_key_jwk: null },
      selectBarrier: {
        match: (sql) => sql.includes('FROM server_keys'),
        count: 2,
      },
    });
    const a = makeMessage({ destination: 'x.example.com', pdu: { event_id: '$x' }, timestamp: NOW });
    const b = makeMessage({ destination: 'y.example.com', pdu: { event_id: '$y' }, timestamp: NOW });
    await handleFederationQueue(
      { messages: [a, b] } as unknown as MessageBatch<QueueBody>,
      { DB: db, SERVER_NAME: 'local.example.com' } as Env
    );
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)));
    expect(bodies.every((body) => body.signatures === undefined)).toBe(true);
  });

  it('invalid JWK sign reject ∥ unsigned success concurrent batches', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const bad = makeMessage(
      { destination: 'bad.example.com', pdu: { event_id: '$j' }, timestamp: NOW },
      1
    );
    const ok = makeMessage({
      destination: 'ok.example.com',
      pdu: { event_id: '$o' },
      timestamp: NOW,
    });
    await Promise.all([
      handleFederationQueue(
        { messages: [bad] } as unknown as MessageBatch<QueueBody>,
        {
          DB: makeConsumerDb({ row: { key_id: 'ed25519:bad', private_key_jwk: 'not-json' } }),
          SERVER_NAME: 'local.example.com',
        } as Env
      ),
      handleFederationQueue(
        { messages: [ok] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('PUT send URL + origin_server_ts pinned under concurrent dests', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    const a = makeMessage({ destination: 'a.example.com', timestamp: NOW });
    const b = makeMessage({
      destination: 'b.example.com',
      edu: { edu_type: 'm.presence', content: { push: [] } },
      timestamp: NOW,
    });
    await handleFederationQueue(
      { messages: [a, b] } as unknown as MessageBatch<QueueBody>,
      { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
    );
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls[0]).toContain(`https://a.example.com/_matrix/federation/v1/send/${NOW}_`);
    expect(urls[1]).toContain(`https://b.example.com/_matrix/federation/v1/send/${NOW}_`);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('PUT');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init.body)).origin_server_ts).toBe(NOW);
    }
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
  });

  for (const status of [200, 201, 204, 301, 400, 404, 429, 503] as const) {
    it(`HTTP ${status} concurrent dest pair ack vs retry`, async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).includes('left.example.com')) {
          return new Response('x', { status });
        }
        return new Response('{}', { status: 200 });
      });
      const left = makeMessage(
        { destination: 'left.example.com', pdu: { event_id: '$l' }, timestamp: NOW },
        0
      );
      const right = makeMessage({
        destination: 'right.example.com',
        pdu: { event_id: '$r' },
        timestamp: NOW,
      });
      await handleFederationQueue(
        { messages: [left, right] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      );
      expect(right.ack).toHaveBeenCalledOnce();
      if (status >= 200 && status < 300) {
        expect(left.ack).toHaveBeenCalledOnce();
        expect(left.retry).not.toHaveBeenCalled();
      } else {
        expect(left.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
        expect(left.ack).not.toHaveBeenCalled();
      }
    });
  }

  it('eight dest concurrent batches isolation soft flood', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      return String(url).includes('fail')
        ? new Response('no', { status: 503 })
        : new Response('{}', { status: 200 });
    });
    const msgs = Array.from({ length: 8 }, (_, i) =>
      makeMessage(
        {
          destination: `${i % 2 === 0 ? 'ok' : 'fail'}${i}.example.com`,
          pdu: { event_id: `$${i}` },
          timestamp: NOW,
        },
        0
      )
    );
    await Promise.all(
      msgs.map((m) =>
        handleFederationQueue(
          { messages: [m] } as unknown as MessageBatch<QueueBody>,
          { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
        )
      )
    );
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) {
        expect(msgs[i].ack).toHaveBeenCalledOnce();
      } else {
        expect(msgs[i].retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Device-list EDU concurrent-race + send route leftovers
// ---------------------------------------------------------------------------

describe('federation-device-list concurrent-race leftovers after #226', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('add∥add same device write-barrier last-write-wins', async () => {
    const db = createDeviceListDb({
      writeBarrier: {
        match: (sql) => sql.includes('INSERT') && sql.includes('remote_device_lists'),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const [a, b] = await Promise.all([
      sendTxn(env, 'txn-add-a', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            device_display_name: 'Phone A',
            stream_id: 10,
            keys: { v: 1 },
          }),
        ],
      }),
      sendTxn(env, 'txn-add-b', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            device_display_name: 'Phone B',
            stream_id: 11,
            keys: { v: 2 },
          }),
        ],
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE));
    expect(['Phone A', 'Phone B']).toContain(row?.device_display_name);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(11);
  });

  it('add∥delete same device write-barrier either present or absent', async () => {
    const db = createDeviceListDb({
      remoteDevices: [
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'Old',
          keys: null,
          stream_id: 1,
          updated_at: 1,
        },
      ],
      writeBarrier: {
        match: (sql) =>
          sql.includes('remote_device_lists') &&
          (sql.includes('INSERT') || sql.includes('DELETE')),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const [add, del] = await Promise.all([
      sendTxn(env, 'txn-add', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            device_display_name: 'New',
            stream_id: 20,
          }),
        ],
      }),
      sendTxn(env, 'txn-del', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            deleted: true,
            stream_id: 21,
          }),
        ],
      }),
    ]);
    expect(add.status).toBe(200);
    expect(del.status).toBe(200);
    const present = db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE));
    expect(typeof present).toBe('boolean');
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(21);
  });

  it('high stream ∥ low stream concurrent MAX wins', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    await Promise.all([
      sendTxn(env, 'txn-hi', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 50,
            device_display_name: 'Hi',
          }),
        ],
      }),
      sendTxn(env, 'txn-lo', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE_B,
            stream_id: 3,
            device_display_name: 'Lo',
          }),
        ],
      }),
    ]);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(50);
    expect(db.remoteDevices.size).toBe(2);
  });

  it('independent users concurrent isolation', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    await Promise.all([
      sendTxn(env, 'txn-u1', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 7,
          }),
        ],
      }),
      sendTxn(env, 'txn-u2', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER_B,
            device_id: REMOTE_DEVICE,
            stream_id: 9,
          }),
        ],
      }),
    ]);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(7);
    expect(db.remoteStreams.get(REMOTE_USER_B)?.stream_id).toBe(9);
  });

  it('same txnId device_list TOCTOU both miss cache then both process', async () => {
    const db = createDeviceListDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT response FROM federation_transactions'),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const body = {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 4,
          device_display_name: 'Race',
        }),
      ],
    };
    const [a, b] = await Promise.all([
      sendTxn(env, 'txn-same', body),
      sendTxn(env, 'txn-same', body),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE))?.stream_id).toBe(4);
    expect(db.processedEdus.filter((e) => e.edu_type === 'm.device_list_update').length).toBeGreaterThanOrEqual(
      2
    );
  });

  it('cached txn replay ∥ fresh txn isolation', async () => {
    const cached = JSON.stringify({ pdus: { cached: true } });
    const db = createDeviceListDb({
      federationTxns: { [`${FED_ORIGIN}|cached`]: cached },
    });
    const env = makeEnv(db);
    const [replay, fresh] = await Promise.all([
      sendTxn(env, 'cached', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 99,
          }),
        ],
      }),
      sendTxn(env, 'fresh', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 5,
            device_display_name: 'Fresh',
          }),
        ],
      }),
    ]);
    expect(replay.body).toEqual({ pdus: { cached: true } });
    expect(fresh.status).toBe(200);
    expect(db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE))?.device_display_name).toBe(
      'Fresh'
    );
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(5);
  });

  it('missing origin dual PUT device_list both 401 and write nothing', async () => {
    federationOrigin = undefined;
    const db = createDeviceListDb();
    const env = makeEnv(db);
    const body = {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 1,
        }),
      ],
    };
    const [a, b] = await Promise.all([
      sendTxn(env, 'txn-noauth-a', body),
      sendTxn(env, 'txn-noauth-b', body),
    ]);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toMatchObject({ errcode: 'M_UNAUTHORIZED' });
    expect(db.remoteDevices.size).toBe(0);
    expect(db.processedEdus).toEqual([]);
  });

  it('malformed JSON ∥ valid device_list concurrent', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    const [bad, good] = await Promise.all([
      sendTxn(env, 'txn-bad', '{not-json'),
      sendTxn(env, 'txn-good', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 2,
          }),
        ],
      }),
    ]);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(good.status).toBe(200);
    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(true);
  });

  it('typing EDU ∥ device_list EDU concurrent isolation', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    await Promise.all([
      sendTxn(env, 'txn-typing', {
        pdus: [],
        edus: [{ edu_type: 'm.typing', content: { room_id: '!r:example.com' } }],
      }),
      sendTxn(env, 'txn-dev', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 6,
          }),
        ],
      }),
    ]);
    expect(db.remoteDevices.size).toBe(1);
    expect(db.processedEdus.some((e) => e.edu_type === 'm.typing')).toBe(true);
    expect(db.processedEdus.some((e) => e.edu_type === 'm.device_list_update')).toBe(true);
  });

  it('empty device_id skip ∥ valid add concurrent', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    await Promise.all([
      sendTxn(env, 'txn-skip', {
        pdus: [],
        edus: [deviceListEdu({ user_id: REMOTE_USER, device_id: '', stream_id: 1 })],
      }),
      sendTxn(env, 'txn-ok', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 12,
          }),
        ],
      }),
    ]);
    expect(db.remoteDevices.size).toBe(1);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(12);
  });

  it('insert failure swallow ∥ other user success concurrent', async () => {
    const failDb = createDeviceListDb({ failRemoteDeviceLists: true });
    const okDb = createDeviceListDb();
    const [fail, ok] = await Promise.all([
      sendTxn(makeEnv(failDb), 'txn-fail', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER,
            device_id: REMOTE_DEVICE,
            stream_id: 1,
          }),
        ],
      }),
      sendTxn(makeEnv(okDb), 'txn-ok', {
        pdus: [],
        edus: [
          deviceListEdu({
            user_id: REMOTE_USER_B,
            device_id: REMOTE_DEVICE,
            stream_id: 2,
          }),
        ],
      }),
    ]);
    expect(fail.status).toBe(200);
    expect(ok.status).toBe(200);
    expect(failDb.remoteDevices.size).toBe(0);
    expect(okDb.remoteDevices.size).toBe(1);
  });

  it('encoded txn id PUT still processes device_list', async () => {
    const db = createDeviceListDb();
    const txn = encodeURIComponent('txn/with spaces');
    const res = await sendTxn(makeEnv(db), txn, {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 1,
          device_display_name: 'Enc',
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE))?.device_display_name).toBe(
      'Enc'
    );
  });
});

describe('federation-device-list send route method leftovers after #226', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  const METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'] as const;

  for (const method of METHODS) {
    it(`${method} /send/:txnId → 404/405 (PUT-only)`, async () => {
      const db = createDeviceListDb();
      const res = await sendTxn(
        makeEnv(db),
        'txn-method',
        {
          pdus: [],
          edus: [
            deviceListEdu({
              user_id: REMOTE_USER,
              device_id: REMOTE_DEVICE,
              stream_id: 1,
            }),
          ],
        },
        method
      );
      expect([404, 405]).toContain(res.status);
      expect(db.remoteDevices.size).toBe(0);
    });
  }

  it('wrong methods concurrent with PUT success isolation', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    const body = {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 3,
          device_display_name: 'PutOnly',
        }),
      ],
    };
    const [getRes, postRes, putRes, delRes] = await Promise.all([
      sendTxn(env, 'txn-m', body, 'GET'),
      sendTxn(env, 'txn-m', body, 'POST'),
      sendTxn(env, 'txn-m-put', body, 'PUT'),
      sendTxn(env, 'txn-m', body, 'DELETE'),
    ]);
    expect([404, 405]).toContain(getRes.status);
    expect([404, 405]).toContain(postRes.status);
    expect([404, 405]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    expect(db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE))?.device_display_name).toBe(
      'PutOnly'
    );
  });

  for (let i = 0; i < 8; i++) {
    it(`send method-matrix flood-${i} GET∥POST both 404/405`, async () => {
      const env = makeEnv(createDeviceListDb());
      const [g, p] = await Promise.all([
        sendTxn(env, `flood-${i}-g`, { pdus: [] }, 'GET'),
        sendTxn(env, `flood-${i}-p`, { pdus: [] }, 'POST'),
      ]);
      expect([404, 405]).toContain(g.status);
      expect([404, 405]).toContain(p.status);
    });
  }
});
