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

describe('notify / auth-chain / servers TOKENMAXX residual leftovers after #252', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getAuthChain with only-missing seed ids returns an empty chain', async () => {
    const events = new Map<string, PDU>([['$known', pdu('$known', [])]]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$missing', '$also-missing']);
    expect(chain).toEqual([]);
  });

  it('getAuthChain seed of missing tip with known auth child still yields empty (tip never loaded)', async () => {
    // Tip id is marked seen but getEventsByIds returns nothing for it — auth children never enqueued
    const events = new Map<string, PDU>([['$child', pdu('$child', [])]]);
    const chain = await getAuthChain(createAuthChainDb(events), ['$ghost']);
    expect(chain).toEqual([]);
  });

  it('getStateAtEvent includes auth events whose state_key is the empty string', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$create'], {
          type: 'm.room.member',
          state_key: '@u:ex.com',
          content: { membership: 'join' },
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
    ]);
    const state = await getStateAtEvent(createAuthChainDb(events), '$leaf');
    expect(state).toHaveLength(1);
    expect(state[0].event_id).toBe('$create');
    expect(state[0].state_key).toBe('');
  });

  it('getStateAtEvent with empty auth_events returns []', async () => {
    const events = new Map<string, PDU>([
      [
        '$solo',
        pdu('$solo', [], {
          type: 'm.room.message',
          content: { body: 'x' },
        }),
      ],
    ]);
    // Delete state_key so the leaf itself would not qualify even if included
    delete (events.get('$solo') as { state_key?: string }).state_key;
    await expect(getStateAtEvent(createAuthChainDb(events), '$solo')).resolves.toEqual([]);
  });

  it('notifyUsersOfEvent resolves when every Sync DO fails', async () => {
    const env = {
      notifies: [] as { userId: string; body: unknown }[],
      DB: {
        prepare(sql: string) {
          return {
            bind(..._args: unknown[]) {
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    return {
                      results: [{ user_id: '@a:example.com' }, { user_id: '@b:example.com' }] as T[],
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
        get: () => ({
          async fetch() {
            throw new Error('all down');
          },
        }),
      },
    } as any;
    await expect(
      notifyUsersOfEvent(env, '!r:example.com', '$e', 'm.room.message')
    ).resolves.toBeUndefined();
    expect(env.notifies).toHaveLength(0);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @a:example.com of event:',
      expect.any(Error)
    );
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @b:example.com of event:',
      expect.any(Error)
    );
  });

  it('getServersInRoomsWithUser binds the userId twice (self-join filter)', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            return {
              async all<T>() {
                return { results: [{ server_name: 'peer.example.com' }] as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(getServersInRoomsWithUser(db, '@alice:example.com')).resolves.toEqual([
      'peer.example.com',
    ]);
    expect(binds).toEqual([['@alice:example.com', '@alice:example.com']]);
  });

  it('getAuthChain does not re-enqueue auth ids already present in the seed batch', async () => {
    const events = new Map<string, PDU>([
      ['$a', pdu('$a', ['$b'])],
      ['$b', pdu('$b', [])],
    ]);
    // Seed both tip and its auth child — child must appear once
    const chain = await getAuthChain(createAuthChainDb(events), ['$a', '$b']);
    expect(chain.map((e) => e.event_id).sort()).toEqual(['$a', '$b']);
    expect(new Set(chain.map((e) => e.event_id)).size).toBe(2);
  });
});

describe('notify / auth-chain / servers TOKENMAXX residual leftovers after #264', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(
    members: string[],
    opts?: { failUsers?: Set<string>; roomId?: string }
  ) {
    const notifies: { userId: string; body: unknown; roomId?: string }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    if (opts?.roomId && args[0] !== opts.roomId) {
                      return { results: [] as T[] };
                    }
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

  it('concurrent notifyUsersOfEvent for two rooms isolates member fan-out', async () => {
    const envA = makeNotifyEnv(['@a:example.com', '@b:example.com']);
    const envB = makeNotifyEnv(['@c:example.com']);
    await Promise.all([
      notifyUsersOfEvent(envA, '!a:example.com', '$ea', 'm.room.message'),
      notifyUsersOfEvent(envB, '!b:example.com', '$eb', 'm.room.member'),
    ]);
    expect(envA.notifies.map((n: { userId: string }) => n.userId).sort()).toEqual([
      '@a:example.com',
      '@b:example.com',
    ]);
    expect(envB.notifies.map((n: { userId: string }) => n.userId)).toEqual(['@c:example.com']);
    expect(envA.notifies[0].body).toMatchObject({
      event_id: '$ea',
      room_id: '!a:example.com',
      type: 'm.room.message',
    });
    expect(envB.notifies[0].body).toMatchObject({
      event_id: '$eb',
      room_id: '!b:example.com',
      type: 'm.room.member',
    });
  });

  it('concurrent getAuthChain on overlapping tips still visits each node once per call', async () => {
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$l', '$r'])],
      ['$l', pdu('$l', ['$root'])],
      ['$r', pdu('$r', ['$root'])],
      ['$root', pdu('$root', [])],
    ]);
    const db = createAuthChainDb(events);
    const [a, b] = await Promise.all([
      getAuthChain(db, ['$tip']),
      getAuthChain(db, ['$l', '$r']),
    ]);
    expect(new Set(a.map((e) => e.event_id)).size).toBe(4);
    expect(new Set(b.map((e) => e.event_id)).size).toBe(3);
    expect(a.map((e) => e.event_id).sort()).toEqual(['$l', '$r', '$root', '$tip'].sort());
    expect(b.map((e) => e.event_id).sort()).toEqual(['$l', '$r', '$root'].sort());
  });

  it('concurrent getStateAtEvent on missing + present leaves stay isolated', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$create'], {
          type: 'm.room.member',
          state_key: '@u:ex.com',
          content: { membership: 'join' },
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
    ]);
    const db = createAuthChainDb(events);
    const [missing, present] = await Promise.all([
      getStateAtEvent(db, '$ghost'),
      getStateAtEvent(db, '$leaf'),
    ]);
    expect(missing).toEqual([]);
    expect(present).toHaveLength(1);
    expect(present[0].event_id).toBe('$create');
  });

  it('concurrent notify with partial Sync DO failures still resolves both rooms', async () => {
    const env = makeNotifyEnv(['@ok:example.com', '@bad:example.com'], {
      failUsers: new Set(['@bad:example.com']),
    });
    await expect(
      Promise.all([
        notifyUsersOfEvent(env, '!r:example.com', '$e1', 'm.room.message'),
        notifyUsersOfEvent(env, '!r:example.com', '$e2', 'm.room.message'),
      ])
    ).resolves.toEqual([undefined, undefined]);
    // Two notifies × one ok user
    expect(env.notifies).toHaveLength(2);
    expect(console.error).toHaveBeenCalled();
  });

  it('getServersInRoomsWithUser concurrent identical binds stay stable', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            return {
              async all<T>() {
                return {
                  results: [{ server_name: 'peer.example.com' }, { server_name: null }] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [a, b] = await Promise.all([
      getServersInRoomsWithUser(db, '@alice:example.com'),
      getServersInRoomsWithUser(db, '@alice:example.com'),
    ]);
    expect(a).toEqual(['peer.example.com']);
    expect(b).toEqual(['peer.example.com']);
    expect(binds).toHaveLength(2);
    expect(binds[0]).toEqual(['@alice:example.com', '@alice:example.com']);
    expect(binds[1]).toEqual(['@alice:example.com', '@alice:example.com']);
  });
});

describe('notify / auth-chain / servers TOKENMAXX residual leftovers after #272', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent notify on one env with roomId filter isolates dual-room fan-out', async () => {
    const notifies: { userId: string; body: unknown }[] = [];
    const membersByRoom: Record<string, string[]> = {
      '!a:example.com': ['@a1:example.com', '@a2:example.com'],
      '!b:example.com': ['@b1:example.com'],
    };
    const env = {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    const roomId = args[0] as string;
                    return {
                      results: (membersByRoom[roomId] ?? []).map((user_id) => ({ user_id })) as T[],
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
            const body = await req.json();
            notifies.push({ userId: id.name, body });
            return new Response('ok');
          },
        }),
      },
    } as any;
    await Promise.all([
      notifyUsersOfEvent(env, '!a:example.com', '$ea', 'm.room.message'),
      notifyUsersOfEvent(env, '!b:example.com', '$eb', 'm.room.member'),
    ]);
    const aUsers = notifies
      .filter((n) => (n.body as { room_id: string }).room_id === '!a:example.com')
      .map((n) => n.userId)
      .sort();
    const bUsers = notifies
      .filter((n) => (n.body as { room_id: string }).room_id === '!b:example.com')
      .map((n) => n.userId);
    expect(aUsers).toEqual(['@a1:example.com', '@a2:example.com']);
    expect(bUsers).toEqual(['@b1:example.com']);
    expect(notifies).toHaveLength(3);
  });

  it('concurrent notify outer catch when membership prepare throws still resolves', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('membership query down');
        },
      },
      SYNC: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          async fetch() {
            return new Response('ok');
          },
        }),
      },
    } as any;
    await expect(
      Promise.all([
        notifyUsersOfEvent(env, '!a:example.com', '$e1', 'm.room.message'),
        notifyUsersOfEvent(env, '!b:example.com', '$e2', 'm.room.message'),
      ])
    ).resolves.toEqual([undefined, undefined]);
    expect(console.error).toHaveBeenCalled();
    const prefixes = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(prefixes.every((p) => p === '[database] Failed to notify users of event:')).toBe(true);
    expect(prefixes.length).toBeGreaterThanOrEqual(2);
  });

  it('concurrent identical getAuthChain tips keep independent seen sets', async () => {
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$l', '$r'])],
      ['$l', pdu('$l', ['$root'])],
      ['$r', pdu('$r', ['$root'])],
      ['$root', pdu('$root', [])],
    ]);
    const db = createAuthChainDb(events);
    const [a, b] = await Promise.all([getAuthChain(db, ['$tip']), getAuthChain(db, ['$tip'])]);
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(new Set(a.map((e) => e.event_id))).toEqual(new Set(['$tip', '$l', '$r', '$root']));
    expect(new Set(b.map((e) => e.event_id))).toEqual(new Set(['$tip', '$l', '$r', '$root']));
  });

  it('concurrent getAuthChain cap warn does not poison a short sibling chain', async () => {
    const deep = new Map<string, PDU>();
    for (let i = 0; i < 520; i++) {
      deep.set(`$d${i}`, pdu(`$d${i}`, i === 0 ? [] : [`$d${i - 1}`]));
    }
    const short = new Map<string, PDU>([
      ['$s2', pdu('$s2', ['$s1'])],
      ['$s1', pdu('$s1', ['$s0'])],
      ['$s0', pdu('$s0', [])],
    ]);
    // Shared DB that serves both graphs
    const combined = new Map<string, PDU>([...deep, ...short]);
    const db = createAuthChainDb(combined);
    const [capped, brief] = await Promise.all([
      getAuthChain(db, ['$d519']),
      getAuthChain(db, ['$s2']),
    ]);
    expect(capped).toHaveLength(500);
    expect(brief.map((e) => e.event_id)).toEqual(['$s2', '$s1', '$s0']);
    expect(console.warn).toHaveBeenCalledWith(
      '[getAuthChain] reached MAX_AUTH_CHAIN_SIZE cap',
      500,
      'aborting traversal'
    );
  });

  it('concurrent getStateAtEvent last-wins on colliding auth type+key', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$a1', '$a2'], {
          type: 'm.room.message',
          content: { body: 'x' },
        }),
      ],
      [
        '$a1',
        pdu('$a1', [], {
          type: 'm.room.name',
          state_key: '',
          content: { name: 'first' },
        }),
      ],
      [
        '$a2',
        pdu('$a2', [], {
          type: 'm.room.name',
          state_key: '',
          content: { name: 'second' },
        }),
      ],
    ]);
    delete (events.get('$leaf') as { state_key?: string }).state_key;
    const db = createAuthChainDb(events);
    const [s1, s2] = await Promise.all([getStateAtEvent(db, '$leaf'), getStateAtEvent(db, '$leaf')]);
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    // last auth id in the leaf's auth_events list wins ($a2)
    expect(s1[0].event_id).toBe('$a2');
    expect(s2[0].event_id).toBe('$a2');
    expect(s1[0].content).toEqual({ name: 'second' });
  });

  it('getServersInRoomsWithUser concurrent distinct users isolate binds and results', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            const subject = args[0] as string;
            return {
              async all<T>() {
                if (subject === '@alice:example.com') {
                  return {
                    results: [
                      { server_name: 'peer-a.example.com' },
                      { server_name: null },
                    ] as T[],
                  };
                }
                return {
                  results: [{ server_name: 'peer-b.example.com' }] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [alice, bob] = await Promise.all([
      getServersInRoomsWithUser(db, '@alice:example.com'),
      getServersInRoomsWithUser(db, '@bob:example.com'),
    ]);
    expect(alice).toEqual(['peer-a.example.com']);
    expect(bob).toEqual(['peer-b.example.com']);
    expect(binds).toHaveLength(2);
    expect(binds).toEqual(
      expect.arrayContaining([
        ['@alice:example.com', '@alice:example.com'],
        ['@bob:example.com', '@bob:example.com'],
      ])
    );
  });
});

describe('notify / auth-chain TOKENMAXX residual second-wave leftovers after #282', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent getAuthChain([]) does not poison a capped sibling chain', async () => {
    const deep = new Map<string, PDU>();
    for (let i = 0; i < 520; i++) {
      deep.set(`$d${i}`, pdu(`$d${i}`, i === 0 ? [] : [`$d${i - 1}`]));
    }
    const db = createAuthChainDb(deep);
    const [empty, capped] = await Promise.all([
      getAuthChain(db, []),
      getAuthChain(db, ['$d519']),
    ]);
    expect(empty).toEqual([]);
    expect(capped).toHaveLength(500);
    expect(console.warn).toHaveBeenCalledWith(
      '[getAuthChain] reached MAX_AUTH_CHAIN_SIZE cap',
      500,
      'aborting traversal'
    );
  });
});

describe('notify / auth-chain TOKENMAXX residual tertiary leftovers after #290', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(
    membersByRoom: Record<string, string[]>,
    opts?: { failUsers?: Set<string> }
  ) {
    const notifies: { userId: string; body: unknown }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              const roomId = args[0] as string;
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    const members = membersByRoom[roomId] ?? [];
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

  it('concurrent notify zero-members room ∥ populated room isolates fan-out', async () => {
    const env = makeNotifyEnv({
      '!empty:example.com': [],
      '!full:example.com': ['@a:example.com', '@b:example.com'],
    });
    await Promise.all([
      notifyUsersOfEvent(env, '!empty:example.com', '$e0', 'm.room.message'),
      notifyUsersOfEvent(env, '!full:example.com', '$e1', 'm.room.member'),
    ]);
    expect(env.notifies.map((n: { userId: string }) => n.userId).sort()).toEqual([
      '@a:example.com',
      '@b:example.com',
    ]);
    expect(env.notifies.every((n: { body: { room_id: string } }) => n.body.room_id === '!full:example.com')).toBe(
      true
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      0,
      'users of event',
      '$e0',
      'users:',
      ''
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      2,
      'users of event',
      '$e1',
      'users:',
      '@a:example.com, @b:example.com'
    );
  });

  it('concurrent getStateAtEvent message-only auth ∥ state auth stay isolated', async () => {
    const events = new Map<string, PDU>([
      [
        '$msg-leaf',
        pdu('$msg-leaf', ['$msg-auth'], {
          type: 'm.room.message',
          content: { body: 'hi' },
        }),
      ],
      [
        '$msg-auth',
        pdu('$msg-auth', [], {
          type: 'm.room.message',
          content: { body: 'auth-msg' },
        }),
      ],
      [
        '$state-leaf',
        pdu('$state-leaf', ['$create'], {
          type: 'm.room.member',
          state_key: '@u:example.com',
          content: { membership: 'join' },
        }),
      ],
      [
        '$create',
        pdu('$create', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:example.com' },
        }),
      ],
    ]);
    delete (events.get('$msg-leaf') as { state_key?: string }).state_key;
    delete (events.get('$msg-auth') as { state_key?: string }).state_key;
    const db = createAuthChainDb(events);
    const [msgState, stateState] = await Promise.all([
      getStateAtEvent(db, '$msg-leaf'),
      getStateAtEvent(db, '$state-leaf'),
    ]);
    expect(msgState).toEqual([]);
    expect(stateState).toHaveLength(1);
    expect(stateState[0].event_id).toBe('$create');
    expect(stateState[0].content).toEqual({ creator: '@s:example.com' });
  });

  it('concurrent getAuthChain duplicate-seed empty-batch path ∥ short chain', async () => {
    const events = new Map<string, PDU>([
      ['$a', pdu('$a', ['$b'])],
      ['$b', pdu('$b', [])],
      ['$c', pdu('$c', [])],
    ]);
    const db = createAuthChainDb(events);
    const [dup, short] = await Promise.all([
      getAuthChain(db, ['$a', '$a', '$a', '$a']),
      getAuthChain(db, ['$c']),
    ]);
    expect(dup.map((e) => e.event_id).sort()).toEqual(['$a', '$b'].sort());
    expect(short.map((e) => e.event_id)).toEqual(['$c']);
  });

  it('getServersInRoomsWithUser empty-string server ∥ null-filter sibling under race', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            const subject = args[0] as string;
            return {
              async all<T>() {
                if (subject === '@keep:example.com') {
                  return {
                    results: [
                      { server_name: '' },
                      { server_name: 'peer.example.com' },
                    ] as T[],
                  };
                }
                return {
                  results: [{ server_name: null }, { server_name: null }] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [keep, drop] = await Promise.all([
      getServersInRoomsWithUser(db, '@keep:example.com'),
      getServersInRoomsWithUser(db, '@drop:example.com'),
    ]);
    // empty string is kept; only null is filtered
    expect(keep).toEqual(['', 'peer.example.com']);
    expect(drop).toEqual([]);
    expect(binds).toHaveLength(2);
  });
});

describe('notify / auth-chain TOKENMAXX residual quaternary leftovers after #310', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(
    membersByRoom: Record<string, string[]>,
    opts?: { failUsers?: Set<string> }
  ) {
    const notifies: { userId: string; body: unknown }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              const roomId = args[0] as string;
              return {
                async all<T>() {
                  if (sql.includes('room_memberships')) {
                    const members = membersByRoom[roomId] ?? [];
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

  it('concurrent notify partial Sync DO fail ∥ success sibling isolates fan-out', async () => {
    const env = makeNotifyEnv(
      {
        '!fail:example.com': ['@ok:example.com', '@bad:example.com'],
        '!ok:example.com': ['@solo:example.com'],
      },
      { failUsers: new Set(['@bad:example.com']) }
    );
    await Promise.all([
      notifyUsersOfEvent(env, '!fail:example.com', '$f', 'm.room.message'),
      notifyUsersOfEvent(env, '!ok:example.com', '$o', 'm.room.member'),
    ]);
    expect(env.notifies.map((n: { userId: string }) => n.userId).sort()).toEqual([
      '@ok:example.com',
      '@solo:example.com',
    ]);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @bad:example.com of event:',
      expect.any(Error)
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      2,
      'users of event',
      '$f',
      'users:',
      '@ok:example.com, @bad:example.com'
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      1,
      'users of event',
      '$o',
      'users:',
      '@solo:example.com'
    );
  });

  it('concurrent getAuthChain missing mid-chain ∥ short sibling stay isolated', async () => {
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$missing', '$leaf'])],
      ['$leaf', pdu('$leaf', [])],
      ['$short', pdu('$short', [])],
    ]);
    const db = createAuthChainDb(events);
    const [partial, short] = await Promise.all([
      getAuthChain(db, ['$tip']),
      getAuthChain(db, ['$short']),
    ]);
    expect(partial.map((e) => e.event_id).sort()).toEqual(['$leaf', '$tip'].sort());
    expect(short.map((e) => e.event_id)).toEqual(['$short']);
  });

  it('concurrent getStateAtEvent empty-auth leaf ∥ missing leaf stay isolated', async () => {
    const events = new Map<string, PDU>([
      [
        '$empty-auth',
        pdu('$empty-auth', [], {
          type: 'm.room.message',
          content: { body: 'x' },
        }),
      ],
    ]);
    delete (events.get('$empty-auth') as { state_key?: string }).state_key;
    const db = createAuthChainDb(events);
    const [emptyAuth, missing] = await Promise.all([
      getStateAtEvent(db, '$empty-auth'),
      getStateAtEvent(db, '$nope'),
    ]);
    expect(emptyAuth).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('getServersInRoomsWithUser multi-segment ∥ empty co-members under race', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            const subject = args[0] as string;
            return {
              async all<T>() {
                if (subject === '@multi:example.com') {
                  return {
                    results: [
                      { server_name: 'a.b.example.com' },
                      { server_name: 'peer.example.com' },
                    ] as T[],
                  };
                }
                return { results: [] as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [multi, empty] = await Promise.all([
      getServersInRoomsWithUser(db, '@multi:example.com'),
      getServersInRoomsWithUser(db, '@alone:example.com'),
    ]);
    expect(multi).toEqual(['a.b.example.com', 'peer.example.com']);
    expect(empty).toEqual([]);
    expect(binds).toHaveLength(2);
    expect(binds[0]).toEqual(['@multi:example.com', '@multi:example.com']);
    expect(binds[1]).toEqual(['@alone:example.com', '@alone:example.com']);
  });
});

describe('notify / auth-chain TOKENMAXX residual quinary leftovers after #319', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(
    membersByRoom: Record<string, string[]>,
    opts?: { failUsers?: Set<string>; throwOnRooms?: Set<string> }
  ) {
    const notifies: { userId: string; body: unknown }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              const roomId = args[0] as string;
              return {
                async all<T>() {
                  if (opts?.throwOnRooms?.has(roomId)) {
                    throw new Error('membership boom');
                  }
                  if (sql.includes('room_memberships')) {
                    const members = membersByRoom[roomId] ?? [];
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

  it('concurrent notify outer-catch room ∥ success sibling isolates fan-out', async () => {
    const env = makeNotifyEnv(
      {
        '!boom:example.com': ['@never:example.com'],
        '!ok:example.com': ['@a:example.com', '@b:example.com'],
      },
      { throwOnRooms: new Set(['!boom:example.com']) }
    );
    await Promise.all([
      notifyUsersOfEvent(env, '!boom:example.com', '$boom', 'm.room.message'),
      notifyUsersOfEvent(env, '!ok:example.com', '$ok', 'm.room.member'),
    ]);
    expect(env.notifies.map((n: { userId: string }) => n.userId).sort()).toEqual([
      '@a:example.com',
      '@b:example.com',
    ]);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify users of event:',
      expect.any(Error)
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      2,
      'users of event',
      '$ok',
      'users:',
      '@a:example.com, @b:example.com'
    );
  });

  it('concurrent getAuthChain self-loop tip ∥ short sibling stay isolated', async () => {
    const events = new Map<string, PDU>([
      ['$loop', pdu('$loop', ['$loop'])],
      ['$short', pdu('$short', [])],
    ]);
    const db = createAuthChainDb(events);
    const [loop, short] = await Promise.all([
      getAuthChain(db, ['$loop']),
      getAuthChain(db, ['$short']),
    ]);
    expect(loop.map((e) => e.event_id)).toEqual(['$loop']);
    expect(short.map((e) => e.event_id)).toEqual(['$short']);
  });

  it('concurrent getAuthChain diamond ∥ empty seed stay isolated', async () => {
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$a', '$b'])],
      ['$a', pdu('$a', ['$root'])],
      ['$b', pdu('$b', ['$root'])],
      ['$root', pdu('$root', [])],
    ]);
    const db = createAuthChainDb(events);
    const [diamond, empty] = await Promise.all([
      getAuthChain(db, ['$tip', '$tip']),
      getAuthChain(db, []),
    ]);
    expect(diamond.map((e) => e.event_id).sort()).toEqual(['$a', '$b', '$root', '$tip'].sort());
    expect(empty).toEqual([]);
  });

  it('concurrent getStateAtEvent empty-string state_key ∥ colliding last-wins stay isolated', async () => {
    const events = new Map<string, PDU>([
      [
        '$empty-key-leaf',
        pdu('$empty-key-leaf', ['$create'], {
          type: 'm.room.message',
          content: { body: 'x' },
        }),
      ],
      [
        '$create',
        pdu('$create', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:example.com' },
        }),
      ],
      [
        '$collide-leaf',
        pdu('$collide-leaf', ['$name1', '$name2'], {
          type: 'm.room.message',
          content: { body: 'y' },
        }),
      ],
      [
        '$name1',
        pdu('$name1', [], {
          type: 'm.room.name',
          state_key: '',
          content: { name: 'first' },
        }),
      ],
      [
        '$name2',
        pdu('$name2', [], {
          type: 'm.room.name',
          state_key: '',
          content: { name: 'second' },
        }),
      ],
    ]);
    delete (events.get('$empty-key-leaf') as { state_key?: string }).state_key;
    delete (events.get('$collide-leaf') as { state_key?: string }).state_key;
    const db = createAuthChainDb(events);
    const [emptyKey, collide] = await Promise.all([
      getStateAtEvent(db, '$empty-key-leaf'),
      getStateAtEvent(db, '$collide-leaf'),
    ]);
    expect(emptyKey).toHaveLength(1);
    expect(emptyKey[0].event_id).toBe('$create');
    expect(emptyKey[0].state_key).toBe('');
    expect(collide).toHaveLength(1);
    expect(collide[0].type).toBe('m.room.name');
    expect(['$name1', '$name2']).toContain(collide[0].event_id);
    // last-wins depends on getEventsByIds order; Map iteration preserves insertion → name2
    expect(collide[0].content).toEqual(
      collide[0].event_id === '$name2' ? { name: 'second' } : { name: 'first' }
    );
  });

  it('getServersInRoomsWithUser duplicate server names ∥ alone under race', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            const subject = args[0] as string;
            return {
              async all<T>() {
                if (subject === '@dup:example.com') {
                  return {
                    results: [
                      { server_name: 'peer.example.com' },
                      { server_name: 'peer.example.com' },
                      { server_name: 'other.example.com' },
                    ] as T[],
                  };
                }
                return { results: [] as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [dups, alone] = await Promise.all([
      getServersInRoomsWithUser(db, '@dup:example.com'),
      getServersInRoomsWithUser(db, '@solo:example.com'),
    ]);
    // DISTINCT is in SQL; harness returns raw rows — pin current harness behavior
    expect(dups).toEqual(['peer.example.com', 'peer.example.com', 'other.example.com']);
    expect(alone).toEqual([]);
    expect(binds).toHaveLength(2);
  });

  it('concurrent notify clock-pinned timestamps stay independent per room', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_111)
      .mockReturnValueOnce(2_222)
      .mockReturnValue(3_333);
    const env = makeNotifyEnv({
      '!r1:example.com': ['@u1:example.com'],
      '!r2:example.com': ['@u2:example.com'],
    });
    await Promise.all([
      notifyUsersOfEvent(env, '!r1:example.com', '$e1', 'm.room.message'),
      notifyUsersOfEvent(env, '!r2:example.com', '$e2', 'm.room.member'),
    ]);
    expect(env.notifies).toHaveLength(2);
    const byUser = Object.fromEntries(
      env.notifies.map((n: { userId: string; body: { timestamp: number; event_id: string } }) => [
        n.userId,
        n.body,
      ])
    );
    expect(byUser['@u1:example.com'].event_id).toBe('$e1');
    expect(byUser['@u2:example.com'].event_id).toBe('$e2');
    expect([1_111, 2_222, 3_333]).toContain(byUser['@u1:example.com'].timestamp);
    expect([1_111, 2_222, 3_333]).toContain(byUser['@u2:example.com'].timestamp);
  });
});

describe('notify / auth-chain TOKENMAXX residual senary leftovers after #330', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(
    membersByRoom: Record<string, string[]>,
    opts?: { failUsers?: Set<string>; throwOnRooms?: Set<string> }
  ) {
    const notifies: { userId: string; body: unknown }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              const roomId = args[0] as string;
              return {
                async all<T>() {
                  if (opts?.throwOnRooms?.has(roomId)) {
                    throw new Error('membership boom');
                  }
                  if (sql.includes('room_memberships')) {
                    const members = membersByRoom[roomId] ?? [];
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

  it('empty-members notify ∥ sibling with members: exact zero log stays isolated', async () => {
    const env = makeNotifyEnv({
      '!empty:example.com': [],
      '!full:example.com': ['@a:example.com'],
    });
    await Promise.all([
      notifyUsersOfEvent(env, '!empty:example.com', '$empty', 'm.room.message'),
      notifyUsersOfEvent(env, '!full:example.com', '$full', 'm.room.member'),
    ]);
    expect(env.notifies.map((n: { userId: string }) => n.userId)).toEqual(['@a:example.com']);
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      0,
      'users of event',
      '$empty',
      'users:',
      ''
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      1,
      'users of event',
      '$full',
      'users:',
      '@a:example.com'
    );
  });

  it('concurrent getAuthChain MAX_AUTH_CHAIN_SIZE ∥ short sibling isolates warn', async () => {
    const long = new Map<string, PDU>();
    for (let i = 0; i < 520; i++) {
      long.set(`$${i}`, pdu(`$${i}`, i === 0 ? [] : [`$${i - 1}`]));
    }
    long.set('$short', pdu('$short', []));
    const db = createAuthChainDb(long);
    const [capped, short] = await Promise.all([
      getAuthChain(db, ['$519']),
      getAuthChain(db, ['$short']),
    ]);
    expect(capped).toHaveLength(500);
    expect(capped[0].event_id).toBe('$519');
    expect(short.map((e) => e.event_id)).toEqual(['$short']);
    expect(console.warn).toHaveBeenCalledWith(
      '[getAuthChain] reached MAX_AUTH_CHAIN_SIZE cap',
      500,
      'aborting traversal'
    );
  });

  it('concurrent getStateAtEvent create+member ∥ missing leaf stay isolated', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$create', '$member'], {
          type: 'm.room.message',
          content: { body: 'x' },
        }),
      ],
      [
        '$create',
        pdu('$create', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:example.com' },
        }),
      ],
      [
        '$member',
        pdu('$member', [], {
          type: 'm.room.member',
          state_key: '@s:example.com',
          content: { membership: 'join' },
        }),
      ],
    ]);
    delete (events.get('$leaf') as { state_key?: string }).state_key;
    const db = createAuthChainDb(events);
    const [state, missing] = await Promise.all([
      getStateAtEvent(db, '$leaf'),
      getStateAtEvent(db, '$nope'),
    ]);
    expect(state).toHaveLength(2);
    expect(state.map((e) => e.type).sort()).toEqual(['m.room.create', 'm.room.member'].sort());
    expect(missing).toEqual([]);
  });

  it('getServersInRoomsWithUser null-filtered ∥ multi under race', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            const subject = args[0] as string;
            return {
              async all<T>() {
                if (subject === '@nulls:example.com') {
                  return {
                    results: [
                      { server_name: null },
                      { server_name: 'peer.example.com' },
                      { server_name: null },
                    ] as T[],
                  };
                }
                if (subject === '@multi:example.com') {
                  return {
                    results: [
                      { server_name: 'a.example.com' },
                      { server_name: 'b.example.com' },
                    ] as T[],
                  };
                }
                return { results: [] as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [withNulls, multi] = await Promise.all([
      getServersInRoomsWithUser(db, '@nulls:example.com'),
      getServersInRoomsWithUser(db, '@multi:example.com'),
    ]);
    expect(withNulls).toEqual(['peer.example.com']);
    expect(multi).toEqual(['a.example.com', 'b.example.com']);
    expect(binds).toHaveLength(2);
  });

  it('concurrent same-room two events both fan-out with distinct event_ids', async () => {
    const env = makeNotifyEnv({
      '!r:example.com': ['@u1:example.com', '@u2:example.com'],
    });
    await Promise.all([
      notifyUsersOfEvent(env, '!r:example.com', '$e1', 'm.room.message'),
      notifyUsersOfEvent(env, '!r:example.com', '$e2', 'm.room.member'),
    ]);
    expect(env.notifies).toHaveLength(4);
    const byEvent = env.notifies.reduce(
      (acc: Record<string, string[]>, n: { userId: string; body: { event_id: string } }) => {
        const id = n.body.event_id;
        acc[id] = acc[id] ?? [];
        acc[id].push(n.userId);
        return acc;
      },
      {}
    );
    expect(byEvent['$e1'].sort()).toEqual(['@u1:example.com', '@u2:example.com']);
    expect(byEvent['$e2'].sort()).toEqual(['@u1:example.com', '@u2:example.com']);
  });

  it('all Sync DO fails in room ∥ success sibling isolates fan-out', async () => {
    const env = makeNotifyEnv(
      {
        '!bad:example.com': ['@x:example.com', '@y:example.com'],
        '!ok:example.com': ['@z:example.com'],
      },
      { failUsers: new Set(['@x:example.com', '@y:example.com']) }
    );
    await Promise.all([
      notifyUsersOfEvent(env, '!bad:example.com', '$bad', 'm.room.message'),
      notifyUsersOfEvent(env, '!ok:example.com', '$ok', 'm.room.member'),
    ]);
    expect(env.notifies.map((n: { userId: string }) => n.userId)).toEqual(['@z:example.com']);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @x:example.com of event:',
      expect.any(Error)
    );
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @y:example.com of event:',
      expect.any(Error)
    );
  });
});

describe('notify / auth-chain TOKENMAXX residual septenary leftovers after #336', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeNotifyEnv(
    membersByRoom: Record<string, string[]>,
    opts?: { failUsers?: Set<string>; throwOnRooms?: Set<string> }
  ) {
    const notifies: { userId: string; body: unknown }[] = [];
    return {
      notifies,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              const roomId = args[0] as string;
              return {
                async all<T>() {
                  if (opts?.throwOnRooms?.has(roomId)) {
                    throw new Error('membership boom');
                  }
                  if (sql.includes('room_memberships')) {
                    const members = membersByRoom[roomId] ?? [];
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

  it('middle Sync DO fail among three ∥ sibling room isolates fan-out', async () => {
    const env = makeNotifyEnv(
      {
        '!r:example.com': ['@a:example.com', '@b:example.com', '@c:example.com'],
        '!ok:example.com': ['@z:example.com'],
      },
      { failUsers: new Set(['@b:example.com']) }
    );
    await Promise.all([
      notifyUsersOfEvent(env, '!r:example.com', '$mid', 'm.room.message'),
      notifyUsersOfEvent(env, '!ok:example.com', '$ok', 'm.room.member'),
    ]);
    expect(env.notifies.map((n: { userId: string }) => n.userId).sort()).toEqual([
      '@a:example.com',
      '@c:example.com',
      '@z:example.com',
    ]);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify user @b:example.com of event:',
      expect.any(Error)
    );
  });

  it('getAuthChain missing middle link ∥ short sibling stay isolated', async () => {
    const events = new Map<string, PDU>([
      ['$tip', pdu('$tip', ['$mid'])],
      // $mid missing — traversal stops for that branch
      ['$short', pdu('$short', [])],
      ['$leaf', pdu('$leaf', [])],
    ]);
    const db = createAuthChainDb(events);
    const [partial, short] = await Promise.all([
      getAuthChain(db, ['$tip', '$leaf']),
      getAuthChain(db, ['$short']),
    ]);
    expect(partial.map((e) => e.event_id).sort()).toEqual(['$leaf', '$tip'].sort());
    expect(short.map((e) => e.event_id)).toEqual(['$short']);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('getStateAtEvent filters non-state auth ∥ keeps create under race with missing', async () => {
    const events = new Map<string, PDU>([
      [
        '$leaf',
        pdu('$leaf', ['$create', '$msg'], {
          type: 'm.room.message',
          content: { body: 'x' },
        }),
      ],
      [
        '$create',
        pdu('$create', [], {
          type: 'm.room.create',
          state_key: '',
          content: { creator: '@s:example.com' },
        }),
      ],
      [
        '$msg',
        pdu('$msg', [], {
          type: 'm.room.message',
          content: { body: 'auth-msg' },
        }),
      ],
    ]);
    delete (events.get('$leaf') as { state_key?: string }).state_key;
    delete (events.get('$msg') as { state_key?: string }).state_key;
    const db = createAuthChainDb(events);
    const [state, missing] = await Promise.all([
      getStateAtEvent(db, '$leaf'),
      getStateAtEvent(db, '$nope'),
    ]);
    expect(state).toHaveLength(1);
    expect(state[0].type).toBe('m.room.create');
    expect(missing).toEqual([]);
  });

  it('getServersInRoomsWithUser all-nulls ∥ empty ∥ multi under race', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            const subject = args[0] as string;
            return {
              async all<T>() {
                if (subject === '@nulls:example.com') {
                  return {
                    results: [{ server_name: null }, { server_name: null }] as T[],
                  };
                }
                if (subject === '@empty:example.com') {
                  return { results: [] as T[] };
                }
                if (subject === '@multi:example.com') {
                  return {
                    results: [
                      { server_name: 'a.example.com' },
                      { server_name: 'b.example.com' },
                    ] as T[],
                  };
                }
                return { results: [] as T[] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const [nulls, empty, multi] = await Promise.all([
      getServersInRoomsWithUser(db, '@nulls:example.com'),
      getServersInRoomsWithUser(db, '@empty:example.com'),
      getServersInRoomsWithUser(db, '@multi:example.com'),
    ]);
    expect(nulls).toEqual([]);
    expect(empty).toEqual([]);
    expect(multi).toEqual(['a.example.com', 'b.example.com']);
    expect(binds).toHaveLength(3);
  });

  it('concurrent overlapping getAuthChain roots share seen-set isolation per call', async () => {
    const events = new Map<string, PDU>([
      ['$a', pdu('$a', ['$shared'])],
      ['$b', pdu('$b', ['$shared'])],
      ['$shared', pdu('$shared', [])],
    ]);
    const db = createAuthChainDb(events);
    const [fromA, fromB] = await Promise.all([
      getAuthChain(db, ['$a']),
      getAuthChain(db, ['$b']),
    ]);
    expect(fromA.map((e) => e.event_id).sort()).toEqual(['$a', '$shared'].sort());
    expect(fromB.map((e) => e.event_id).sort()).toEqual(['$b', '$shared'].sort());
  });

  it('notify membership boom outer-catch ∥ empty-members sibling both isolate', async () => {
    const env = makeNotifyEnv(
      {
        '!boom:example.com': ['@x:example.com'],
        '!empty:example.com': [],
      },
      { throwOnRooms: new Set(['!boom:example.com']) }
    );
    await Promise.all([
      notifyUsersOfEvent(env, '!boom:example.com', '$boom', 'm.room.message'),
      notifyUsersOfEvent(env, '!empty:example.com', '$empty', 'm.room.member'),
    ]);
    expect(env.notifies).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(
      '[database] Failed to notify users of event:',
      expect.any(Error)
    );
    expect(console.log).toHaveBeenCalledWith(
      '[database] Notifying',
      0,
      'users of event',
      '$empty',
      'users:',
      ''
    );
  });
});
