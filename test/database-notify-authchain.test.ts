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


describe('notify / auth-chain / servers TOKENMAXX leftovers after #226', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it('notifyUsersOfEvent fans out in parallel and logs the member count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const members = Array.from({ length: 12 }, (_, i) => `@u${i}:example.com`);
    const env = makeNotifyEnv(members);
    await notifyUsersOfEvent(env, '!r:example.com', '$evt', 'm.room.message');
    expect(env.notifies).toHaveLength(12);
    expect(new Set(env.notifies.map((n: { userId: string }) => n.userId)).size).toBe(12);
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      12,
      'users of event',
      '$evt',
      'users:',
      members.join(', ')
    );
  });

  it('notifyUsersOfEvent resolves when every Sync DO fails', async () => {
    const members = ['@a:example.com', '@b:example.com', '@c:example.com'];
    const env = makeNotifyEnv(members, { failUsers: new Set(members) });
    await expect(
      notifyUsersOfEvent(env, '!r:example.com', '$e', 'm.room.encrypted')
    ).resolves.toBeUndefined();
    expect(env.notifies).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it('getStateAtEvent skips missing auth ids and never includes the leaf itself', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$present', '$ghost'], {
          type: 'm.room.message',
          state_key: undefined,
          content: { body: 'hi', msgtype: 'm.text' },
        }),
      ],
      [
        '$present',
        pdu('$present', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:ex.com' },
        }),
      ],
    ]);
    const state = await getStateAtEvent(createAuthChainDb(events), '$leaf');
    expect(state.map((e) => e.event_id)).toEqual(['$present']);
    expect(state.find((e) => e.event_id === '$leaf')).toBeUndefined();
  });

  it('getAuthChain abandons remaining queue once MAX_AUTH_CHAIN_SIZE is reached', async () => {
    // Linear tip → 600 deep. Cap at 500; remaining queue must not keep growing the chain.
    const events = new Map<string, PDU>();
    for (let i = 0; i < 600; i++) {
      events.set(`$${i}`, pdu(`$${i}`, i === 0 ? [] : [`$${i - 1}`]));
    }
    const chain = await getAuthChain(createAuthChainDb(events), ['$599']);
    expect(chain).toHaveLength(500);
    expect(chain[0].event_id).toBe('$599');
    expect(chain[499].event_id).toBe('$100');
  });

  it('getAuthChain pages a 120-child fan-out across multiple 50-id batches', async () => {
    const events = new Map<string, PDU>();
    const children: string[] = [];
    for (let i = 0; i < 120; i++) {
      const id = `$c${i}`;
      children.push(id);
      events.set(id, pdu(id, []));
    }
    events.set('$tip', pdu('$tip', children));
    const chain = await getAuthChain(createAuthChainDb(events), ['$tip']);
    expect(chain).toHaveLength(121);
    expect(chain[0].event_id).toBe('$tip');
    expect(new Set(chain.map((e) => e.event_id)).size).toBe(121);
  });

  it('getServersInRoomsWithUser binds the subject userId twice', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            return {
              async all<T>() {
                if (sql.includes('room_memberships')) {
                  return { results: [{ server_name: 'peer.example.com' }] as T[] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const servers = await getServersInRoomsWithUser(db, '@alice:example.com');
    expect(servers).toEqual(['peer.example.com']);
    expect(binds).toEqual([['@alice:example.com', '@alice:example.com']]);
  });

  it('getServersInRoomsWithUser keeps distinct multi-segment server names', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return {
                  results: [
                    { server_name: 'a.b.example.com' },
                    { server_name: 'matrix.org' },
                    { server_name: 'a.b.example.com' },
                  ] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    // SQL DISTINCT already applied; filter only drops nulls
    const servers = await getServersInRoomsWithUser(db, '@alice:example.com');
    expect(servers).toEqual(['a.b.example.com', 'matrix.org', 'a.b.example.com']);
  });
});

describe('notify / auth-chain / servers TOKENMAXX leftovers after #232', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeNotifyEnv(
    members: string[],
    opts?: {
      failUsers?: Set<string>;
      captureRequests?: Array<{ method: string; contentType: string | null; body: unknown }>;
    }
  ) {
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
            opts?.captureRequests?.push({
              method: req.method,
              contentType: req.headers.get('Content-Type'),
              body,
            });
            notifies.push({ userId: id.name, body });
            return new Response('ok');
          },
        }),
      },
    } as any;
  }

  it('notifyUsersOfEvent POSTs application/json with event/room/type fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const captureRequests: Array<{ method: string; contentType: string | null; body: unknown }> =
      [];
    const env = makeNotifyEnv(['@alice:example.com'], { captureRequests });
    await notifyUsersOfEvent(env, '!r:example.com', '$evt', 'm.room.member');
    expect(captureRequests).toEqual([
      {
        method: 'POST',
        contentType: 'application/json',
        body: {
          event_id: '$evt',
          room_id: '!r:example.com',
          type: 'm.room.member',
          timestamp: NOW,
        },
      },
    ]);
  });

  it('notifyUsersOfEvent logs per-user Sync DO failures with the user id', async () => {
    const env = makeNotifyEnv(['@ok:example.com', '@bad:example.com'], {
      failUsers: new Set(['@bad:example.com']),
    });
    await notifyUsersOfEvent(env, '!r:example.com', '$e', 'm.room.message');
    expect(env.notifies.map((n: { userId: string }) => n.userId)).toEqual(['@ok:example.com']);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @bad:example.com of event:',
      expect.any(Error)
    );
  });

  it('notifyUsersOfEvent outer catch logs a stable prefix when membership query throws', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('prepare boom');
        },
      },
      SYNC: { idFromName: () => ({}), get: () => ({}) },
    } as any;
    await expect(
      notifyUsersOfEvent(env, '!r:example.com', '$e', 'm.room.message')
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify users of event:',
      expect.any(Error)
    );
  });

  it('getStateAtEvent ignores non-state auth events (missing state_key)', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$create', '$msg'], {
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
        '$msg',
        pdu('$msg', [], {
          type: 'm.room.message',
          state_key: undefined,
          content: { body: 'prior', msgtype: 'm.text' },
        }),
      ],
    ]);
    // Delete state_key so it is truly undefined (pdu helper may not set it)
    delete (events.get('$msg') as { state_key?: string }).state_key;
    delete (events.get('$leaf') as { state_key?: string }).state_key;
    const state = await getStateAtEvent(createAuthChainDb(events), '$leaf');
    expect(state.map((e) => e.event_id)).toEqual(['$create']);
  });

  it('getAuthChain warns when the 500-event cap aborts a deep linear traversal', async () => {
    const events = new Map<string, PDU>();
    for (let i = 0; i < 520; i++) {
      events.set(`$${i}`, pdu(`$${i}`, i === 0 ? [] : [`$${i - 1}`]));
    }
    const chain = await getAuthChain(createAuthChainDb(events), ['$519']);
    expect(chain).toHaveLength(500);
    expect(console.warn).toHaveBeenCalledWith(
      '[getAuthChain] reached MAX_AUTH_CHAIN_SIZE cap',
      500,
      'aborting traversal'
    );
  });

  it('parallel getAuthChain calls on disjoint tips stay isolated', async () => {
    const events = new Map<string, PDU>([
      ['$a1', pdu('$a1', ['$a0'])],
      ['$a0', pdu('$a0', [])],
      ['$b1', pdu('$b1', ['$b0'])],
      ['$b0', pdu('$b0', [])],
    ]);
    const db = createAuthChainDb(events);
    const [a, b] = await Promise.all([getAuthChain(db, ['$a1']), getAuthChain(db, ['$b1'])]);
    expect(a.map((e) => e.event_id)).toEqual(['$a1', '$a0']);
    expect(b.map((e) => e.event_id)).toEqual(['$b1', '$b0']);
  });

  it('getServersInRoomsWithUser drops null server_name rows from the result list', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return {
                  results: [
                    { server_name: null },
                    { server_name: 'peer.example.com' },
                    { server_name: null },
                  ] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(getServersInRoomsWithUser(db, '@alice:example.com')).resolves.toEqual([
      'peer.example.com',
    ]);
  });

  it('getAuthChain with duplicate seed ids across a diamond still visits each node once', async () => {
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$l', '$r'])],
      ['$l', pdu('$l', ['$root'])],
      ['$r', pdu('$r', ['$root'])],
      ['$root', pdu('$root', [])],
    ]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$tip', '$tip', '$l']);
    expect(new Set(chain.map((e) => e.event_id)).size).toBe(4);
    expect(chain.map((e) => e.event_id).sort()).toEqual(['$l', '$r', '$root', '$tip'].sort());
  });

  it('notifyUsersOfEvent with a single member still logs the notify line', async () => {
    const env = makeNotifyEnv(['@solo:example.com']);
    await notifyUsersOfEvent(env, '!r:example.com', '$solo', 'm.room.message');
    expect(env.notifies).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      1,
      'users of event',
      '$solo',
      'users:',
      '@solo:example.com'
    );
  });
});

describe('notify / auth-chain / servers TOKENMAXX leftovers after #241', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifyUsersOfEvent with zero members still logs the notify line', async () => {
    const env = {
      notifies: [] as { userId: string; body: unknown }[],
      DB: {
        prepare(sql: string) {
          return {
            bind(..._args: unknown[]) {
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    return { results: [] as T[] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
      SYNC: {
        idFromName: () => ({ name: 'unused' }),
        get: () => ({
          async fetch() {
            return new Response('ok');
          },
        }),
      },
    } as any;
    await notifyUsersOfEvent(env, '!r:example.com', '$none', 'm.room.message');
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      0,
      'users of event',
      '$none',
      'users:',
      ''
    );
  });

  it('notifyUsersOfEvent binds roomId and names Sync DOs from each user_id', async () => {
    const binds: unknown[][] = [];
    const names: string[] = [];
    const env = {
      DB: {
        prepare(_sql: string) {
          return {
            bind(...args: unknown[]) {
              binds.push(args);
              return {
                async all<T>() {
                  return {
                    results: [
                      { user_id: '@alice:example.com' },
                      { user_id: '@bob:example.com' },
                    ] as T[],
                  };
                },
              };
            },
          };
        },
      },
      SYNC: {
        idFromName: (name: string) => {
          names.push(name);
          return { name };
        },
        get: (id: { name: string }) => ({
          async fetch() {
            return new Response('ok');
          },
        }),
      },
    } as any;
    await notifyUsersOfEvent(env, '!lobby:example.com', '$e', 'm.room.message');
    expect(binds).toEqual([['!lobby:example.com']]);
    expect(names.sort()).toEqual(['@alice:example.com', '@bob:example.com']);
  });

  it('getStateAtEvent is one-level only (does not recurse into auth of auth)', async () => {
    // Implementation fetches auth_events of the leaf via getEventsByIds — not getAuthChain.
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$parent'], {
          type: 'm.room.member',
          state_key: '@u:ex.com',
          content: { membership: 'join' },
        }),
      ],
      [
        '$parent',
        pdu('$parent', ['$grand'], {
          type: 'm.room.member',
          state_key: '@p:ex.com',
          content: { membership: 'join' },
        }),
      ],
      [
        '$grand',
        pdu('$grand', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:ex.com' },
        }),
      ],
    ]);
    const state = await getStateAtEvent(createAuthChainDb(events), '$leaf');
    expect(state.map((e) => e.event_id)).toEqual(['$parent']);
    expect(state.map((e) => e.event_id)).not.toContain('$grand');
  });

  it('getAuthChain handles a self-referential auth_events edge without looping', async () => {
    const events = new Map<string, PDU>([['$self', pdu('$self', ['$self'])]]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$self']);
    expect(chain).toHaveLength(1);
    expect(chain[0].event_id).toBe('$self');
  });

  it('getServersInRoomsWithUser keeps empty-string server_name (only null is filtered)', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return {
                  results: [
                    { server_name: '' },
                    { server_name: 'peer.example.com' },
                    { server_name: null },
                  ] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(getServersInRoomsWithUser(db, '@alice:example.com')).resolves.toEqual([
      '',
      'peer.example.com',
    ]);
  });
});
