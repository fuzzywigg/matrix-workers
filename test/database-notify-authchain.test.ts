import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAuthChain,
  getStateAtEvent,
  getServersInRoomsWithUser,
  notifyUsersOfEvent,
} from '../src/services/database';
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

describe('getStateAtEvent / getAuthChain / getServersInRoomsWithUser TOKENMAXX after #69', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getStateAtEvent returns [] when the event is missing', async () => {
    await expect(getStateAtEvent(createAuthChainDb(new Map()), '$missing')).resolves.toEqual([]);
  });

  it('getStateAtEvent builds state from auth events with state_key', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$create', '$member', '$msg'], {
          type: 'm.room.message',
          state_key: undefined,
          content: { body: 'hi', msgtype: 'm.text' },
        }),
      ],
      [
        '$create',
        pdu('$create', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:ex.com' },
        }),
      ],
      [
        '$member',
        pdu('$member', ['$create'], {
          type: 'm.room.member',
          state_key: '@s:ex.com',
          content: { membership: 'join' },
        }),
      ],
      // Non-state auth row (no state_key) must be skipped
      [
        '$msg',
        pdu('$msg', [], {
          type: 'm.room.message',
          state_key: undefined,
          content: { body: 'auth-msg', msgtype: 'm.text' },
        }),
      ],
    ]);
    const state = await getStateAtEvent(createAuthChainDb(events), '$leaf');
    const ids = state.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$create', '$member']);
    expect(state.find((e) => e.event_id === '$msg')).toBeUndefined();
  });

  it('getStateAtEvent returns empty state when auth_events is empty', async () => {
    const events = new Map<string, PDU>([['$solo', pdu('$solo', [])]]);
    await expect(getStateAtEvent(createAuthChainDb(events), '$solo')).resolves.toEqual([]);
  });

  it('getStateAtEvent last-wins on duplicate (type, state_key) among auth rows', async () => {
    // getEventsByIds returns rows in IN-list order; later duplicate key overwrites map
    const events = new Map<string, PDU>([
      ['$e', pdu('$e', ['$m1', '$m2'])],
      [
        '$m1',
        pdu('$m1', [], {
          type: 'm.room.member',
          state_key: '@s:ex.com',
          content: { membership: 'invite' },
        }),
      ],
      [
        '$m2',
        pdu('$m2', [], {
          type: 'm.room.member',
          state_key: '@s:ex.com',
          content: { membership: 'join' },
        }),
      ],
    ]);
    const state = await getStateAtEvent(createAuthChainDb(events), '$e');
    expect(state).toHaveLength(1);
    expect(state[0].event_id).toBe('$m2');
    expect(state[0].content).toEqual({ membership: 'join' });
  });

  it('getAuthChain skips missing mid-chain ids and continues', async () => {
    const events = new Map<string, PDU>([
      ['$a', pdu('$a', ['$missing', '$b'])],
      ['$b', pdu('$b', [])],
    ]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$a']);
    expect(chain.map((e) => e.event_id).sort()).toEqual(['$a', '$b']);
  });

  it('getAuthChain continues when a batch is all already-seen (diamond graph)', async () => {
    // Diamond: tip → left & right → shared root. Seeding tip then left causes
    // right's auth of root to hit seen and produce an empty filtered batch.
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$left', '$right'])],
      ['$left', pdu('$left', ['$root'])],
      ['$right', pdu('$right', ['$root'])],
      ['$root', pdu('$root', [])],
    ]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$tip']);
    expect(chain.map((e) => e.event_id).sort()).toEqual(['$left', '$right', '$root', '$tip']);
  });

  it('getAuthChain batches queue at 50 ids per getEventsByIds call', async () => {
    // One tip with 55 direct auth children → first batch 50, second batch 5 (+ tip consumed)
    const events = new Map<string, PDU>();
    const childIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `$c${i}`;
      childIds.push(id);
      events.set(id, pdu(id, []));
    }
    events.set('$tip', pdu('$tip', childIds));
    const chain = await getAuthChain(createAuthChainDb(events), ['$tip']);
    expect(chain).toHaveLength(56); // tip + 55 children
    expect(chain[0].event_id).toBe('$tip');
  });

  it('getAuthChain returns empty when seed ids have no rows', async () => {
    await expect(
      getAuthChain(createAuthChainDb(new Map()), ['$ghost1', '$ghost2'])
    ).resolves.toEqual([]);
  });

  it('getAuthChain multi-parent fan-in collects all unique events', async () => {
    const events = new Map<string, PDU>([
      ['$e1', pdu('$e1', ['$a', '$b'])],
      ['$e2', pdu('$e2', ['$b', '$c'])],
      ['$a', pdu('$a', [])],
      ['$b', pdu('$b', [])],
      ['$c', pdu('$c', [])],
    ]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$e1', '$e2']);
    expect(chain.map((e) => e.event_id).sort()).toEqual(['$a', '$b', '$c', '$e1', '$e2']);
  });

  function createServersDb(rows: { user_id: string }[]) {
    return {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async all<T>() {
                if (sql.includes('room_memberships')) {
                  // Mirror SQL DISTINCT on computed server_name
                  const seen = new Set<string | null>();
                  const results: { server_name: string | null }[] = [];
                  for (const r of rows) {
                    const colon = r.user_id.indexOf(':');
                    const server_name = colon > 0 ? r.user_id.slice(colon + 1) : null;
                    const key = server_name;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    results.push({ server_name });
                  }
                  return { results: results as T[] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  it('getServersInRoomsWithUser extracts distinct server names', async () => {
    const db = createServersDb([
      { user_id: '@bob:matrix.org' },
      { user_id: '@carol:matrix.org' },
      { user_id: '@dan:example.com' },
    ]);
    const servers = await getServersInRoomsWithUser(db, '@alice:ex.com');
    expect(servers.sort()).toEqual(['example.com', 'matrix.org']);
  });

  it('getServersInRoomsWithUser filters null server_name (no colon in MXID)', async () => {
    // SQL CASE returns NULL when INSTR is 0; mock mirrors that for malformed ids
    const db = createServersDb([{ user_id: 'not-an-mxid' }, { user_id: '@ok:good.example' }]);
    const servers = await getServersInRoomsWithUser(db, '@alice:ex.com');
    expect(servers).toEqual(['good.example']);
  });

  it('getServersInRoomsWithUser returns empty when no co-members', async () => {
    await expect(getServersInRoomsWithUser(createServersDb([]), '@alice:ex.com')).resolves.toEqual(
      []
    );
  });

  it('getStateAtEvent includes empty-string state_key events', async () => {
    const events = new Map<string, PDU>([
      ['$e', pdu('$e', ['$create', '$jr'])],
      [
        '$create',
        pdu('$create', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:ex.com' },
        }),
      ],
      [
        '$jr',
        pdu('$jr', [], {
          type: 'm.room.join_rules',
          state_key: '',
          content: { join_rule: 'public' },
        }),
      ],
    ]);
    const state = await getStateAtEvent(createAuthChainDb(events), '$e');
    expect(state.map((e) => e.event_id).sort()).toEqual(['$create', '$jr']);
  });

  it('getAuthChain stops enqueueing further auth when cap hit mid-batch', async () => {
    // Tip with many children: after pushing 500th event, remaining auth ids in that
    // event are not enqueued (break before the for-authId loop continues for later events).
    const events = new Map<string, PDU>();
    // Build a wide tree: $0..$498 are leaves; $tip auths all of them plus one more chain
    const leaves: string[] = [];
    for (let i = 0; i < 499; i++) {
      leaves.push(`$${i}`);
      events.set(`$${i}`, pdu(`$${i}`, []));
    }
    events.set('$tip', pdu('$tip', leaves));
    const chain = await getAuthChain(createAuthChainDb(events), ['$tip']);
    expect(chain).toHaveLength(500);
    expect(chain[0].event_id).toBe('$tip');
  });
});
