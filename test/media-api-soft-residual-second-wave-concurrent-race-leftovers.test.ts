/**
 * TOKENMAXX HEAVY leftovers after #301 first soft∥success concurrent wave /
 * tip past #303 — residual *media* soft→*concurrent-race* second-wave binds
 * unsaturated by:
 *   #301 first wave (MIME / Content-Length M_TOO_LARGE / Remote media /
 *        Missing url / SSRF / placeholder remote+other+overwrite — never
 *        `Media not found`, never body-byteLength M_TOO_LARGE, never
 *        placeholder missing-row Media not found under Promise.all),
 *   media-api-routes / media-api-route-leftovers (sequential Media not
 *        found + body oversize only),
 *   keys-media concurrent (TOCTOU success / config; no soft Media not
 *        found ∥ success matrix).
 *
 * Gap table (why leftover after #301):
 *   download/thumbnail/v1 `Media not found` ∥ local 200
 *     | sequential only; remote soft claimed, missing local never under PA
 *   thumbnail missing-metadata + missing-R2 object softs ∥ local
 *     | never under *media*concurrent*
 *   placeholder PUT `Media not found` ∥ own empty fill
 *     | #301 remote/other/overwrite triple only
 *   body byteLength `File exceeds maximum upload size` (Content-Length
 *     under max) ∥ small upload
 *     | #301 Content-Length header path only
 *   multi-error: Media not found ∥ Remote ∥ MIME ∥ Missing url ∥ successes
 *     | #301 cross-route without Media not found
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No invent-product / secrets / DNS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

let opaqueSeq = 0;
vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: async (length: number = 18) => {
      opaqueSeq += 1;
      const base = `mediaid${opaqueSeq}`.padEnd(Math.max(length, 8), '0');
      return base.slice(0, Math.max(length, base.length));
    },
  };
});

import mediaApp from '../src/api/media';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const PREVIEW_OK_URL = 'https://example.org/page';
const PREVIEW_CACHE_KEY = `preview:${PREVIEW_OK_URL}`;
const PREVIEW_CACHED = { 'og:title': 'Cached Example', 'og:site_name': 'example.org' };

const MEDIA_NOT_FOUND = {
  errcode: 'M_NOT_FOUND',
  error: 'Media not found',
} as const;

const REMOTE_NOT_SUPPORTED = {
  errcode: 'M_NOT_FOUND',
  error: 'Remote media not supported',
} as const;

const FILE_EXCEEDS = {
  errcode: 'M_TOO_LARGE',
  error: 'File exceeds maximum upload size',
} as const;

const MISSING_URL = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: url',
} as const;

type MediaRow = {
  media_id: string;
  user_id: string;
  content_type: string;
  content_length: number;
  filename: string | null;
  created_at: number;
};

type SqlCall = { sql: string; args: unknown[] };

type R2ObjectLike = {
  body: ReadableStream | ArrayBuffer | Uint8Array | string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

type MediaBucket = {
  store: Map<string, R2ObjectLike>;
  puts: Array<{ key: string; body: ArrayBuffer | Uint8Array | string; options?: unknown }>;
  gets: string[];
  get: (key: string) => Promise<R2ObjectLike | null>;
  put: (
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ) => Promise<void>;
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

type CacheKv = {
  data: Record<string, string>;
  puts: KvPut[];
  gets: string[];
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

type MediaDb = {
  rows: MediaRow[];
  inserts: SqlCall[];
  updates: SqlCall[];
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      run: () => Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
      all: <T>() => Promise<{ results: T[] }>;
    };
  };
};

function createMediaDb(opts: { rows?: MediaRow[] } = {}): MediaDb {
  const rows = opts.rows ? [...opts.rows] : [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];

  return {
    rows,
    inserts,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT content_type, filename FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const row = rows.find((r) => r.media_id === mediaId);
                if (!row) return null;
                return { content_type: row.content_type, filename: row.filename } as T;
              }

              if (sql.includes('SELECT content_type FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const row = rows.find((r) => r.media_id === mediaId);
                if (!row) return null;
                return { content_type: row.content_type } as T;
              }

              if (sql.includes('SELECT user_id, content_length FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const row = rows.find((r) => r.media_id === mediaId);
                if (!row) return null;
                return { user_id: row.user_id, content_length: row.content_length } as T;
              }

              return null;
            },

            async run() {
              if (sql.includes('INSERT INTO media')) {
                inserts.push({ sql, args });
                if (sql.includes('filename')) {
                  const [mediaId, userId, contentType, contentLength, filename, createdAt] = args as [
                    string,
                    string,
                    string,
                    number,
                    string | null,
                    number,
                  ];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: contentType,
                    content_length: contentLength,
                    filename,
                    created_at: createdAt,
                  });
                } else if (
                  sql.includes("'application/octet-stream'") &&
                  sql.includes('content_length') &&
                  args.length === 3
                ) {
                  const [mediaId, userId, createdAt] = args as [string, string, number];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: 'application/octet-stream',
                    content_length: 0,
                    filename: null,
                    created_at: createdAt,
                  });
                } else {
                  const [mediaId, userId, contentType, contentLength, createdAt] = args as [
                    string,
                    string,
                    string,
                    number,
                    number,
                  ];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: contentType,
                    content_length: contentLength,
                    filename: null,
                    created_at: createdAt,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: rows.length } };
              }

              if (sql.includes('UPDATE media SET content_type')) {
                updates.push({ sql, args });
                const [contentType, contentLength, filename, mediaId] = args as [
                  string,
                  number,
                  string | null,
                  string,
                ];
                const row = rows.find((r) => r.media_id === mediaId);
                if (row) {
                  row.content_type = contentType;
                  row.content_length = contentLength;
                  row.filename = filename;
                  return { success: true, meta: { changes: 1, last_row_id: 0 } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }

              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },

            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

function createMediaBucket(seed: Record<string, R2ObjectLike> = {}): MediaBucket {
  const store = new Map<string, R2ObjectLike>(Object.entries(seed));
  const puts: MediaBucket['puts'] = [];
  const gets: string[] = [];

  return {
    store,
    puts,
    gets,
    async get(key: string) {
      gets.push(key);
      return store.get(key) ?? null;
    },
    async put(key, body, options) {
      puts.push({ key, body, options });
      const normalized =
        typeof body === 'string'
          ? body
          : body instanceof ArrayBuffer
            ? body
            : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      store.set(key, {
        body: normalized as ArrayBuffer | string,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
    },
  };
}

function createCache(data: Record<string, string> = {}): CacheKv {
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const store = { ...data };

  return {
    data: store,
    puts,
    gets,
    async get(key: string) {
      gets.push(key);
      return store[key] ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store[key] = value;
      puts.push({ key, value, options });
    },
    async delete(key: string) {
      delete store[key];
    },
  };
}

function envFor(opts: {
  db?: MediaDb;
  media?: MediaBucket;
  cache?: CacheKv;
  serverName?: string;
} = {}): Env & { _db: MediaDb; _media: MediaBucket; _cache: CacheKv } {
  const db = opts.db ?? createMediaDb();
  const media = opts.media ?? createMediaBucket();
  const cache = opts.cache ?? createCache();
  return {
    DB: db as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: opts.serverName ?? SERVER,
    _db: db,
    _media: media,
    _cache: cache,
  } as unknown as Env & { _db: MediaDb; _media: MediaBucket; _cache: CacheKv };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = envFor()
): Promise<{
  status: number;
  body: any;
  headers: Headers;
  text: string;
  env: Env & { _db?: MediaDb; _media?: MediaBucket; _cache?: CacheKv };
}> {
  const res = await mediaApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text, env };
}

function seedRow(partial: Partial<MediaRow> & { media_id: string }): MediaRow {
  return {
    media_id: partial.media_id,
    user_id: partial.user_id ?? USER,
    content_type: partial.content_type ?? 'image/png',
    content_length: partial.content_length ?? 4,
    filename: partial.filename ?? null,
    created_at: partial.created_at ?? 1_700_000_000_000,
  };
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function softBody(results: Array<{ status: number; body: any }>, status: number) {
  return results.find((r) => r.status === status)!;
}

function seedLocalDownload(mediaId: string, body = 'PNGDATA') {
  const db = createMediaDb({
    rows: [seedRow({ media_id: mediaId, content_type: 'image/png', content_length: body.length })],
  });
  const media = createMediaBucket({
    [mediaId]: { body, httpMetadata: { contentType: 'image/png' } },
  });
  return { db, media };
}

function seedPreviewCache(extra: Record<string, string> = {}) {
  return createCache({
    [PREVIEW_CACHE_KEY]: JSON.stringify(PREVIEW_CACHED),
    ...extra,
  });
}

beforeEach(() => {
  opaqueSeq = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Media not found (download) ∥ local success — never under #301
// ---------------------------------------------------------------------------

describe('media residual concurrent Media not found download ∥ local after #301', () => {
  it('v3 missing R2 object ∥ local download — exact Media not found', async () => {
    const local = seedLocalDownload('loc-dl-1');
    const env = envFor(local);
    const results = await Promise.all([
      request(`/_matrix/media/v3/download/${SERVER}/missing-dl-1`, {}, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc-dl-1`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    expect(softBody(results, 200).text).toBe('PNGDATA');
  });

  it('v3 download+filename missing ∥ local under race', async () => {
    const local = seedLocalDownload('loc-fn-1', 'FILE');
    const env = envFor(local);
    const results = await Promise.all([
      request(`/_matrix/media/v3/download/${SERVER}/gone-fn/a.png`, {}, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc-fn-1/a.png`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
  });

  it('v1 authenticated download missing ∥ local under race', async () => {
    const local = seedLocalDownload('loc-v1-1', 'AUTH');
    const env = envFor(local);
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/download/${SERVER}/nope-v1`, {}, env),
      request(`/_matrix/client/v1/media/download/${SERVER}/loc-v1-1`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    expect(softBody(results, 200).text).toBe('AUTH');
  });

  for (let i = 0; i < 8; i++) {
    it(`Media not found download flood-${i} v3 ∥ v1 ok`, async () => {
      const id = `loc-f-${i}`;
      const local = seedLocalDownload(id, `B${i}`);
      const env = envFor(local);
      const results = await Promise.all([
        request(`/_matrix/media/v3/download/${SERVER}/miss-f-${i}`, {}, env),
        request(`/_matrix/client/v1/media/download/${SERVER}/${id}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404]);
      expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
      expect(softBody(results, 200).text).toBe(`B${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Media not found (thumbnail) ∥ local — metadata miss + R2 miss
// ---------------------------------------------------------------------------

describe('media residual concurrent Media not found thumbnail ∥ local after #301', () => {
  it('thumbnail no DB metadata ∥ local fallback original', async () => {
    const local = seedLocalDownload('loc-th-1');
    const env = envFor(local);
    const results = await Promise.all([
      request(`/_matrix/media/v3/thumbnail/${SERVER}/no-meta?width=32&height=32`, {}, env),
      request(`/_matrix/media/v3/thumbnail/${SERVER}/loc-th-1?width=32&height=32`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
  });

  it('thumbnail DB row but missing R2 object ∥ local under race', async () => {
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: 'ghost-th', content_type: 'image/png' }),
        seedRow({ media_id: 'loc-th-2', content_type: 'image/png', content_length: 4 }),
      ],
    });
    const media = createMediaBucket({
      'loc-th-2': { body: 'OKTH', httpMetadata: { contentType: 'image/png' } },
    });
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/media/v3/thumbnail/${SERVER}/ghost-th?width=16&height=16`, {}, env),
      request(`/_matrix/media/v3/thumbnail/${SERVER}/loc-th-2?width=16&height=16`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
  });

  it('v1 thumbnail missing ∥ v3 local under race', async () => {
    const local = seedLocalDownload('loc-th-v1');
    const env = envFor(local);
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/thumbnail/${SERVER}/miss-th?width=8&height=8`, {}, env),
      request(`/_matrix/media/v3/thumbnail/${SERVER}/loc-th-v1?width=8&height=8`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
  });

  for (let i = 0; i < 6; i++) {
    it(`thumbnail Media not found flood-${i}`, async () => {
      const id = `loc-thf-${i}`;
      const local = seedLocalDownload(id, `T${i}`);
      const env = envFor(local);
      const path =
        i % 2 === 0
          ? `/_matrix/media/v3/thumbnail/${SERVER}/miss-thf-${i}?width=8&height=8`
          : `/_matrix/client/v1/media/thumbnail/${SERVER}/miss-thf-${i}?width=8&height=8`;
      const results = await Promise.all([
        request(path, {}, env),
        request(`/_matrix/media/v3/thumbnail/${SERVER}/${id}?width=8&height=8`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404]);
      expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    });
  }
});

// ---------------------------------------------------------------------------
// Placeholder Media not found ∥ own empty fill — #301 never claimed
// ---------------------------------------------------------------------------

describe('media residual concurrent placeholder Media not found ∥ fill after #301', () => {
  it('missing placeholder row ∥ own empty fill — exact Media not found', async () => {
    const emptyId = 'ph-sw2-empty';
    const db = createMediaDb({
      rows: [seedRow({ media_id: emptyId, content_length: 0, content_type: 'application/octet-stream' })],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph-missing-row`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytesOf('no'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytesOf('ok'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    expect(softBody(results, 200).body).toEqual({});
    expect(media.puts).toHaveLength(1);
  });

  it('quad soft incl Media not found ∥ one empty fill under race', async () => {
    const emptyId = 'ph-sw2-quad';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: emptyId, content_length: 0 }),
        seedRow({ media_id: 'ph-sw2-other', user_id: OTHER, content_length: 0 }),
        seedRow({ media_id: 'ph-sw2-filled', content_length: 5 }),
      ],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph-sw2-gone`, {
        method: 'PUT',
        body: bytesOf('a'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${REMOTE}/x`, {
        method: 'PUT',
        body: bytesOf('b'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph-sw2-other`, {
        method: 'PUT',
        body: bytesOf('c'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph-sw2-filled`, {
        method: 'PUT',
        body: bytesOf('d'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        body: bytesOf('ok'),
      }, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    expect(softBody(results, 409).body.error).toBe('Media already uploaded');
  });

  for (let i = 0; i < 6; i++) {
    it(`placeholder Media not found flood-${i}`, async () => {
      const emptyId = `ph-sw2-f-${i}`;
      const db = createMediaDb({
        rows: [seedRow({ media_id: emptyId, content_length: 0 })],
      });
      const media = createMediaBucket();
      const env = envFor({ db, media });
      const results = await Promise.all([
        request(`/_matrix/client/v1/media/upload/${SERVER}/gone-${i}`, {
          method: 'PUT',
          body: bytesOf('x'),
        }, env),
        request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
          method: 'PUT',
          body: bytesOf('y'),
        }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404]);
      expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    });
  }
});

// ---------------------------------------------------------------------------
// Body byteLength M_TOO_LARGE (Content-Length under max) ∥ ok — #301 header only
// ---------------------------------------------------------------------------

describe('media residual concurrent body-byteLength M_TOO_LARGE ∥ ok after #301', () => {
  it('v3 actual body oversize + small Content-Length ∥ small upload', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const oversized = new ArrayBuffer(MAX_UPLOAD_SIZE + 2);
    const okBody = bytesOf('tiny');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '2',
        },
        body: oversized,
      }, env),
      request('/_matrix/media/v3/upload?filename=ok.bin', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 413]);
    expect(softBody(results, 413).body).toEqual(FILE_EXCEEDS);
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
    expect(media.puts).toHaveLength(1);
  });

  it('v1 body oversize ∥ v3 ok under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const oversized = new ArrayBuffer(MAX_UPLOAD_SIZE + 4);
    const okBody = bytesOf('ok');
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1',
        },
        body: oversized,
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 413]);
    expect(softBody(results, 413).body).toEqual(FILE_EXCEEDS);
    expect(media.puts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-error soft matrix incl Media not found — never claimed after #301
// ---------------------------------------------------------------------------

describe('media residual concurrent multi-error soft isolation after #301', () => {
  it('Media not found + Remote + MIME + Missing url ∥ download+upload+cached', async () => {
    const local = seedLocalDownload('loc-mx-1', 'MX');
    const cache = seedPreviewCache();
    const env = envFor({ ...local, cache });
    const okBody = bytesOf('png');
    const results = await Promise.all([
      request(`/_matrix/media/v3/download/${SERVER}/gone-mx`, {}, env),
      request(`/_matrix/media/v3/download/${REMOTE}/r-mx`, {}, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html', 'Content-Length': '1' },
        body: bytesOf('x'),
      }, env),
      request('/_matrix/media/v3/preview_url', {}, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc-mx-1`, {}, env),
      request('/_matrix/media/v3/upload?filename=ok.png', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
      request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`, {}, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 404)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    const notFoundErrors = results
      .filter((r) => r.status === 404)
      .map((r) => r.body.error)
      .sort();
    expect(notFoundErrors).toEqual(['Media not found', 'Remote media not supported'].sort());
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: text/html');
    expect(softBody(results, 400).body).toEqual(MISSING_URL);
  });

  it('Media not found thumbnail + Remote thumbnail + placeholder missing ∥ locals', async () => {
    const emptyId = 'ph-mx-empty';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: 'loc-mx-th', content_type: 'image/png', content_length: 4 }),
        seedRow({ media_id: emptyId, content_length: 0 }),
      ],
    });
    const media = createMediaBucket({
      'loc-mx-th': { body: 'THMX', httpMetadata: { contentType: 'image/png' } },
    });
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/media/v3/thumbnail/${SERVER}/no-th?width=8&height=8`, {}, env),
      request(`/_matrix/media/v3/thumbnail/${REMOTE}/r?width=8&height=8`, {}, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/gone-ph`, {
        method: 'PUT',
        body: bytesOf('n'),
      }, env),
      request(`/_matrix/media/v3/thumbnail/${SERVER}/loc-mx-th?width=8&height=8`, {}, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        body: bytesOf('y'),
      }, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 404)).toHaveLength(3);
    expect(
      results
        .filter((r) => r.status === 404)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(['Media not found', 'Media not found', 'Remote media not supported'].sort());
  });

  for (let i = 0; i < 6; i++) {
    it(`multi-error Media not found isolation flood-${i}`, async () => {
      const id = `loc-mxf-${i}`;
      const local = seedLocalDownload(id, `F${i}`);
      const env = envFor(local);
      const results = await Promise.all([
        request(`/_matrix/media/v3/download/${SERVER}/gone-mxf-${i}`, {}, env),
        request(`/_matrix/media/v3/download/${REMOTE}/r-mxf-${i}`, {}, env),
        request(`/_matrix/media/v3/download/${SERVER}/${id}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404, 404]);
      expect(
        results
          .filter((r) => r.status === 404)
          .map((r) => r.body)
          .sort((a, b) => String(a.error).localeCompare(String(b.error)))
      ).toEqual([MEDIA_NOT_FOUND, REMOTE_NOT_SUPPORTED].sort((a, b) => a.error.localeCompare(b.error)));
      expect(softBody(results, 200).text).toBe(`F${i}`);
    });
  }
});
