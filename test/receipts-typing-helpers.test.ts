import { describe, it, expect, vi } from 'vitest';
import { getReceiptsForRoom, getReceiptsForRooms } from '../src/api/receipts';
import { getTypingUsers, getTypingForRooms } from '../src/api/typing';
import type { Env } from '../src/types';

type ReceiptBlob = Record<
  string,
  Record<string, Record<string, { ts: number; thread_id?: string }>>
>;

function mockRoomsNamespace(
  byRoom: Record<
    string,
    | { kind: 'receipts'; receipts: ReceiptBlob }
    | { kind: 'typing'; user_ids: string[] }
    | { kind: 'throw'; error: Error }
    | { kind: 'http'; status: number; body: unknown }
  >
) {
  const ids = new Map<string, { name: string }>();
  return {
    idFromName(roomId: string) {
      const id = { name: roomId };
      ids.set(roomId, id);
      return id;
    },
    get(id: { name: string }) {
      const roomId = id.name;
      return {
        async fetch(request: Request) {
          const entry = byRoom[roomId];
          if (!entry) {
            return new Response(JSON.stringify({ receipts: {}, user_ids: [] }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (entry.kind === 'throw') {
            throw entry.error;
          }
          if (entry.kind === 'http') {
            return new Response(JSON.stringify(entry.body), {
              status: entry.status,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const url = new URL(request.url);
          if (entry.kind === 'receipts' && url.pathname.endsWith('/receipts')) {
            return new Response(JSON.stringify({ receipts: entry.receipts }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (entry.kind === 'typing' && url.pathname.endsWith('/typing')) {
            return new Response(JSON.stringify({ user_ids: entry.user_ids }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ receipts: {}, user_ids: [] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
      };
    },
  };
}

function envWithRooms(
  byRoom: Parameters<typeof mockRoomsNamespace>[0]
): Env {
  return {
    ROOMS: mockRoomsNamespace(byRoom),
  } as unknown as Env;
}

describe('getReceiptsForRoom — private filter', () => {
  const receipts: ReceiptBlob = {
    '$pub': {
      'm.read': {
        '@alice:ex.com': { ts: 100 },
        '@bob:ex.com': { ts: 200 },
      },
      'm.read.private': {
        '@alice:ex.com': { ts: 110, thread_id: '$thread' },
        '@bob:ex.com': { ts: 220 },
      },
    },
    '$only-private-other': {
      'm.read.private': {
        '@bob:ex.com': { ts: 300 },
      },
    },
    '$only-private-self': {
      'm.read.private': {
        '@alice:ex.com': { ts: 400 },
      },
    },
  };

  it('returns unfiltered receipts when requestingUserId is omitted', async () => {
    const env = envWithRooms({
      '!r:ex.com': { kind: 'receipts', receipts },
    });

    const result = await getReceiptsForRoom(env, '!r:ex.com');
    expect(result).toEqual({ type: 'm.receipt', content: receipts });
  });

  it('keeps public receipts and only the requester’s m.read.private', async () => {
    const env = envWithRooms({
      '!r:ex.com': { kind: 'receipts', receipts },
    });

    const result = await getReceiptsForRoom(env, '!r:ex.com', '@alice:ex.com');
    expect(result.type).toBe('m.receipt');
    expect(result.content['$pub']).toEqual({
      'm.read': {
        '@alice:ex.com': { ts: 100 },
        '@bob:ex.com': { ts: 200 },
      },
      'm.read.private': {
        '@alice:ex.com': { ts: 110, thread_id: '$thread' },
      },
    });
    expect(result.content['$only-private-self']).toEqual({
      'm.read.private': {
        '@alice:ex.com': { ts: 400 },
      },
    });
    expect(result.content['$only-private-other']).toBeUndefined();
  });

  it('drops event entries that become empty after private filtering', async () => {
    const env = envWithRooms({
      '!r:ex.com': {
        kind: 'receipts',
        receipts: {
          '$gone': {
            'm.read.private': { '@other:ex.com': { ts: 1 } },
          },
        },
      },
    });

    const result = await getReceiptsForRoom(env, '!r:ex.com', '@me:ex.com');
    expect(result.content).toEqual({});
  });

  it('preserves thread_id on filtered private receipts', async () => {
    const env = envWithRooms({
      '!r:ex.com': {
        kind: 'receipts',
        receipts: {
          '$e': {
            'm.read.private': {
              '@me:ex.com': { ts: 99, thread_id: '$t' },
            },
          },
        },
      },
    });

    const result = await getReceiptsForRoom(env, '!r:ex.com', '@me:ex.com');
    expect(result.content['$e']['m.read.private']['@me:ex.com']).toEqual({
      ts: 99,
      thread_id: '$t',
    });
  });
});

describe('getReceiptsForRooms — aggregation / isolation', () => {
  it('returns {} for an empty room list', async () => {
    const env = envWithRooms({});
    expect(await getReceiptsForRooms(env, [], '@u:ex.com')).toEqual({});
  });

  it('omits rooms whose filtered content is empty', async () => {
    const env = envWithRooms({
      '!empty:ex.com': { kind: 'receipts', receipts: {} },
      '!full:ex.com': {
        kind: 'receipts',
        receipts: {
          '$e': { 'm.read': { '@a:ex.com': { ts: 1 } } },
        },
      },
    });

    const result = await getReceiptsForRooms(
      env,
      ['!empty:ex.com', '!full:ex.com'],
      '@u:ex.com'
    );
    expect(Object.keys(result)).toEqual(['!full:ex.com']);
    expect(result['!full:ex.com']).toEqual({
      '$e': { 'm.read': { '@a:ex.com': { ts: 1 } } },
    });
  });

  it('isolates per-room DO failures to empty content (room omitted)', async () => {
    const env = envWithRooms({
      '!bad:ex.com': { kind: 'throw', error: new Error('DO down') },
      '!ok:ex.com': {
        kind: 'receipts',
        receipts: {
          '$e': { 'm.read': { '@a:ex.com': { ts: 5 } } },
        },
      },
    });

    const result = await getReceiptsForRooms(
      env,
      ['!bad:ex.com', '!ok:ex.com'],
      '@u:ex.com'
    );
    expect(result['!bad:ex.com']).toBeUndefined();
    expect(result['!ok:ex.com']['$e']['m.read']['@a:ex.com'].ts).toBe(5);
  });

  it('applies private filtering per room when requestingUserId is set', async () => {
    const env = envWithRooms({
      '!r1:ex.com': {
        kind: 'receipts',
        receipts: {
          '$e': {
            'm.read.private': {
              '@alice:ex.com': { ts: 1 },
              '@bob:ex.com': { ts: 2 },
            },
          },
        },
      },
    });

    const forAlice = await getReceiptsForRooms(
      env,
      ['!r1:ex.com'],
      '@alice:ex.com'
    );
    expect(forAlice['!r1:ex.com']['$e']['m.read.private']).toEqual({
      '@alice:ex.com': { ts: 1 },
    });

    const forCarol = await getReceiptsForRooms(
      env,
      ['!r1:ex.com'],
      '@carol:ex.com'
    );
    expect(forCarol['!r1:ex.com']).toBeUndefined();
  });
});

describe('getTypingUsers / getTypingForRooms', () => {
  it('returns user_ids from the Room DO typing endpoint', async () => {
    const env = envWithRooms({
      '!r:ex.com': { kind: 'typing', user_ids: ['@a:ex.com', '@b:ex.com'] },
    });
    expect(await getTypingUsers(env, '!r:ex.com')).toEqual([
      '@a:ex.com',
      '@b:ex.com',
    ]);
  });

  it('returns {} for an empty room list', async () => {
    expect(await getTypingForRooms(envWithRooms({}), [])).toEqual({});
  });

  it('omits rooms with no typing users', async () => {
    const env = envWithRooms({
      '!quiet:ex.com': { kind: 'typing', user_ids: [] },
      '!busy:ex.com': { kind: 'typing', user_ids: ['@typer:ex.com'] },
    });

    expect(
      await getTypingForRooms(env, ['!quiet:ex.com', '!busy:ex.com'])
    ).toEqual({
      '!busy:ex.com': ['@typer:ex.com'],
    });
  });

  it('isolates per-room DO failures without failing the batch', async () => {
    const env = envWithRooms({
      '!bad:ex.com': { kind: 'throw', error: new Error('boom') },
      '!ok:ex.com': { kind: 'typing', user_ids: ['@ok:ex.com'] },
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await getTypingForRooms(env, ['!bad:ex.com', '!ok:ex.com'])
      ).toEqual({
        '!ok:ex.com': ['@ok:ex.com'],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('fetches rooms in parallel (all stubs invoked)', async () => {
    const seen: string[] = [];
    const env = {
      ROOMS: {
        idFromName(roomId: string) {
          return { name: roomId };
        },
        get(id: { name: string }) {
          return {
            async fetch() {
              seen.push(id.name);
              await new Promise((r) => setTimeout(r, 5));
              return new Response(
                JSON.stringify({ user_ids: [`@u-${id.name}`] }),
                { headers: { 'Content-Type': 'application/json' } }
              );
            },
          };
        },
      },
    } as unknown as Env;

    const result = await getTypingForRooms(env, [
      '!a:ex.com',
      '!b:ex.com',
      '!c:ex.com',
    ]);
    expect(seen.sort()).toEqual(['!a:ex.com', '!b:ex.com', '!c:ex.com']);
    expect(Object.keys(result).sort()).toEqual([
      '!a:ex.com',
      '!b:ex.com',
      '!c:ex.com',
    ]);
  });
});
