import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAuthChain, notifyUsersOfEvent } from '../src/services/database';
import type { PDU } from '../src/types/matrix';

const NOW = 1_700_000_000_000;

/** Minimal PDU for auth-chain traversal tests. */
function pdu(
  id: string,
  auth: string[],
  extras: Partial<PDU> = {}
): PDU {
  return {
    event_id: id,
    room_id: '!r:ex.com',
    sender: '@s:ex.com',
    type: 'm.room.member',
    state_key: '@s:ex.com',
    content: {},
    origin_server_ts: NOW,
    depth: 1,
    auth_events: auth,
    prev_events: [],
    hashes: { sha256: 'x' },
    signatures: {},
    ...extras,
  };
}

function createAuthChainDb(events: Map<string, PDU>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM events') && sql.includes('event_id = ?')) {
                const id = args[0] as string;
                const e = events.get(id);
                if (!e) return null;
                return {
                  event_id: e.event_id,
                  room_id: e.room_id,
                  sender: e.sender,
                  event_type: e.type,
                  state_key: e.state_key ?? null,
                  content: JSON.stringify(e.content),
                  origin_server_ts: e.origin_server_ts,
                  unsigned: e.unsigned ? JSON.stringify(e.unsigned) : null,
                  depth: e.depth,
                  auth_events: JSON.stringify(e.auth_events),
                  prev_events: JSON.stringify(e.prev_events),
                  hashes: JSON.stringify(e.hashes),
                  signatures: JSON.stringify(e.signatures),
                  stream_ordering: 1,
                } as T;
              }
              return null;
            },
            async all<T>() {
              // getEventsByIds uses IN (...) — D1 returns unique rows even if placeholders repeat
              if (sql.includes('FROM events') && sql.includes('IN (')) {
                const ids = [...new Set(args as string[])];
                return {
                  results: ids
                    .map((id) => events.get(id))
                    .filter(Boolean)
                    .map((e) => ({
                      event_id: e!.event_id,
                      room_id: e!.room_id,
                      sender: e!.sender,
                      event_type: e!.type,
                      state_key: e!.state_key ?? null,
                      content: JSON.stringify(e!.content),
                      origin_server_ts: e!.origin_server_ts,
                      unsigned: e!.unsigned ? JSON.stringify(e!.unsigned) : null,
                      depth: e!.depth,
                      auth_events: JSON.stringify(e!.auth_events),
                      prev_events: JSON.stringify(e!.prev_events),
                      hashes: JSON.stringify(e!.hashes),
                      signatures: JSON.stringify(e!.signatures),
                      stream_ordering: 1,
                    })) as T[],
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getAuthChain MAX_AUTH_CHAIN_SIZE boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty chain for empty input', async () => {
    await expect(getAuthChain(createAuthChainDb(new Map()), [])).resolves.toEqual([]);
  });

  it('traverses a short auth chain and dedupes repeated seed ids', async () => {
    const events = new Map<string, PDU>([
      ['$a', pdu('$a', ['$b'])],
      ['$b', pdu('$b', ['$c'])],
      ['$c', pdu('$c', [])],
    ]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$a', '$a']);
    expect(chain.map((e) => e.event_id)).toEqual(['$a', '$b', '$c']);
  });

  it('aborts at MAX_AUTH_CHAIN_SIZE (500) and does not enqueue further auth ids', async () => {
    // Linear chain of 520 events: $0 ← $1 ← … ← $519 (each points at previous)
    const events = new Map<string, PDU>();
    for (let i = 0; i < 520; i++) {
      const id = `$${i}`;
      const auth = i === 0 ? [] : [`$${i - 1}`];
      // Build from tip: start with $519 which auths $518 … down to $0
      events.set(id, pdu(id, auth));
    }
    // Actually we need tip → root: $519 auths $518, …
    // Rebuild properly: event $n has auth [$n-1]
    events.clear();
    for (let i = 0; i < 520; i++) {
      events.set(`$${i}`, pdu(`$${i}`, i === 0 ? [] : [`$${i - 1}`]));
    }

    const chain = await getAuthChain(createAuthChainDb(events), ['$519']);
    expect(chain).toHaveLength(500);
    expect(chain[0].event_id).toBe('$519');
    expect(chain[499].event_id).toBe('$20'); // 519 down 499 steps → 20
    expect(console.warn).toHaveBeenCalledWith(
      '[getAuthChain] reached MAX_AUTH_CHAIN_SIZE cap',
      500,
      'aborting traversal'
    );
  });

  it('keeps expanding at size 499 then stops when the 500th event is pushed', async () => {
    const events = new Map<string, PDU>();
    for (let i = 0; i < 501; i++) {
      events.set(`$${i}`, pdu(`$${i}`, i === 0 ? [] : [`$${i - 1}`]));
    }
    const chain = await getAuthChain(createAuthChainDb(events), ['$500']);
    expect(chain).toHaveLength(500);
    expect(chain[499].event_id).toBe('$1');
  });
});

describe('notifyUsersOfEvent clock-pinned timestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(members: string[], opts?: { failUsers?: Set<string> }) {
    const notifies: { userId: string; body: unknown }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(..._args: unknown[]) {
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    return {
                      results: members.map((user_id) => ({ user_id })) as T[],
                    };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
      SYNC: {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          async fetch(req: Request) {
            if (opts?.failUsers?.has(id.name)) throw new Error('do fail');
            const body = await req.json();
            notifies.push({ userId: id.name, body });
            return new Response('ok');
          },
        }),
      },
    } as any;
  }

  it('pins notify body timestamp to NOW for all members', async () => {
    const env = makeNotifyEnv(['@a:ex.com', '@b:ex.com']);
    await notifyUsersOfEvent(env, '!r:ex.com', '$e', 'm.room.message');
    expect(env.notifies).toHaveLength(2);
    for (const n of env.notifies) {
      expect(n.body).toEqual({
        event_id: '$e',
        room_id: '!r:ex.com',
        type: 'm.room.message',
        timestamp: NOW,
      });
    }
  });

  it('uses mid-flight clock for timestamp when Date.now advances before notify map runs', async () => {
    // Advance before calling so all timestamps see NOW+10
    vi.setSystemTime(NOW + 10);
    const env = makeNotifyEnv(['@a:ex.com']);
    await notifyUsersOfEvent(env, '!r:ex.com', '$e2', 'm.room.encrypted');
    expect(env.notifies[0].body).toMatchObject({ timestamp: NOW + 10 });
  });

  it('continues when one Sync DO fails', async () => {
    const env = makeNotifyEnv(['@ok:ex.com', '@bad:ex.com'], {
      failUsers: new Set(['@bad:ex.com']),
    });
    await notifyUsersOfEvent(env, '!r:ex.com', '$e', 'm.room.message');
    expect(env.notifies.map((n: { userId: string }) => n.userId)).toEqual(['@ok:ex.com']);
    expect(console.error).toHaveBeenCalled();
  });

  it('swallows outer failures (membership query throw) without throwing', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  throw new Error('db down');
                },
              };
            },
          };
        },
      },
      SYNC: { idFromName: () => ({}), get: () => ({}) },
    } as any;
    await expect(
      notifyUsersOfEvent(env, '!r:ex.com', '$e', 'm.room.message')
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('no-ops gracefully with zero joined members', async () => {
    const env = makeNotifyEnv([]);
    await notifyUsersOfEvent(env, '!r:ex.com', '$e', 'm.room.message');
    expect(env.notifies).toEqual([]);
  });
});
