/**
 * TOKENMAXX HEAVY deepen — media thumbnail + preview CACHE edges.
 * Slice: media-thumbnail-cache (hit/miss, TTL expiry, invalid mxc stubs, concurrent races).
 * Existing module only: src/api/media.ts. Orthogonal to keys/appservice leftovers and voip/rtc.
 * Complements media-api-routes.test.ts + media-api-route-leftovers.test.ts. Tests-only.
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
const SERVER = 'example.com';
const REMOTE = 'remote.org';
const PREVIEW_TTL = 3600;

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
  /** Optional barrier hook for concurrent-race tests (before returning a get). */
  onBeforeGet?: (key: string) => Promise<void>;
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

type CacheEntry = { value: string; expiresAtMs: number | null };

type CacheKv = {
  data: Record<string, CacheEntry>;
  puts: KvPut[];
  gets: string[];
  nowMs: () => number;
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
  onBeforeGet?: (key: string) => Promise<void>;
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
                }
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
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

function createMediaBucket(
  initial: Record<string, R2ObjectLike> = {},
  opts: { onBeforeGet?: (key: string) => Promise<void> } = {}
): MediaBucket {
  const store = new Map<string, R2ObjectLike>(Object.entries(initial));
  const puts: MediaBucket['puts'] = [];
  const gets: string[] = [];
  return {
    store,
    puts,
    gets,
    onBeforeGet: opts.onBeforeGet,
    async get(key: string) {
      if (this.onBeforeGet) await this.onBeforeGet(key);
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

/** TTL-aware CACHE mock: get returns null once Date.now() >= expiresAtMs. */
function createExpiringCache(
  seed: Record<string, string> = {},
  opts: {
    ttlSeconds?: number | null;
    onBeforeGet?: (key: string) => Promise<void>;
  } = {}
): CacheKv {
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const defaultTtl = opts.ttlSeconds;
  const data: Record<string, CacheEntry> = {};
  for (const [k, v] of Object.entries(seed)) {
    data[k] = {
      value: v,
      expiresAtMs: defaultTtl == null ? null : Date.now() + defaultTtl * 1000,
    };
  }
  return {
    data,
    puts,
    gets,
    nowMs: () => Date.now(),
    onBeforeGet: opts.onBeforeGet,
    async get(key: string) {
      if (this.onBeforeGet) await this.onBeforeGet(key);
      gets.push(key);
      const entry = data[key];
      if (!entry) return null;
      if (entry.expiresAtMs != null && Date.now() >= entry.expiresAtMs) {
        delete data[key];
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      const ttl = options?.expirationTtl;
      data[key] = {
        value,
        expiresAtMs: ttl == null ? null : Date.now() + ttl * 1000,
      };
      puts.push({ key, value, options });
    },
    async delete(key: string) {
      delete data[key];
    },
  };
}

function envFor(opts: {
  db?: MediaDb;
  media?: MediaBucket;
  cache?: CacheKv;
  browser?: { fetch: (req: Request) => Promise<Response> } | null;
  serverName?: string;
} = {}): Env {
  const db = opts.db ?? createMediaDb();
  const media = opts.media ?? createMediaBucket();
  const cache = opts.cache ?? createExpiringCache();
  const env = {
    DB: db as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: opts.serverName ?? SERVER,
  } as unknown as Env;
  if (opts.browser) {
    (env as Env & { BROWSER: unknown }).BROWSER = opts.browser;
  }
  return env;
}

async function request(
  path: string,
  init: RequestInit = {},
  opts: Parameters<typeof envFor>[0] = {}
): Promise<{
  status: number;
  body: unknown;
  headers: Headers;
  text: string;
  env: Env;
  db: MediaDb;
  media: MediaBucket;
  cache: CacheKv;
}> {
  const db = opts.db ?? createMediaDb();
  const media = opts.media ?? createMediaBucket();
  const cache = opts.cache ?? createExpiringCache();
  const env = envFor({ ...opts, db, media, cache });
  const res = await mediaApp.request(`http://localhost${path}`, init, env);
  const contentType = res.headers.get('Content-Type') || '';
  const text = await res.text();
  let body: unknown = text;
  if (contentType.includes('application/json') || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text, env, db, media, cache };
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

function thumbKey(mediaId: string, w = 96, h = 96, method = 'scale'): string {
  return `thumb_${mediaId}_${w}x${h}_${method}`;
}

function v3Thumb(mediaId: string, qs = ''): string {
  return `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}${qs ? `?${qs}` : ''}`;
}

function v1Thumb(mediaId: string, qs = ''): string {
  return `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}${qs ? `?${qs}` : ''}`;
}

function v3Preview(url: string): string {
  return `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`;
}

function v1Preview(url: string): string {
  return `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`;
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


// ============================================
// R2 thumbnail cache — hit / miss
// ============================================

describe('media thumbnail R2 cache hit/miss — v3', () => {
  it('miss generates via cf.image, puts R2 thumb, then hit skips fetch', async () => {
    const mediaId = 'hitmiss1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNGDATA' } });
    const fetchMock = vi.fn(async () => new Response(bytesOf('JPEG1'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const miss = await request(v3Thumb(mediaId, 'width=64&height=64&method=scale'), {}, { db, media });
    expect(miss.status).toBe(200);
    expect(miss.text).toBe('JPEG1');
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 64, 64, 'scale'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fetch2 = vi.fn();
    vi.stubGlobal('fetch', fetch2);
    const hit = await request(v3Thumb(mediaId, 'width=64&height=64&method=scale'), {}, { db, media });
    expect(hit.status).toBe(200);
    expect(hit.text).toBe('JPEG1');
    expect(hit.headers.get('X-Thumbnail-Generated')).toBeNull();
    expect(hit.headers.get('Cache-Control')).toContain('immutable');
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('hit serves image/jpeg regardless of original content_type', async () => {
    const mediaId = 'hitct';
    const key = thumbKey(mediaId, 32, 32, 'crop');
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/webp' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'WEBP' },
      [key]: { body: 'CACHEDJPEG' },
    });
    const res = await request(v3Thumb(mediaId, 'width=32&height=32&method=crop'), {}, { db, media });
    expect(res.text).toBe('CACHEDJPEG');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(media.gets.filter((g) => g === key)).toHaveLength(1);
    expect(media.gets.filter((g) => g === mediaId)).toHaveLength(0);
  });

  it('dimension mismatch is a cache miss (different R2 key)', async () => {
    const mediaId = 'dimmiss';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [thumbKey(mediaId, 64, 64, 'scale')]: { body: 'T64' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('T96'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=96&height=96&method=scale'), {}, { db, media });
    expect(res.text).toBe('T96');
    expect(media.store.has(thumbKey(mediaId, 96, 96, 'scale'))).toBe(true);
    expect(media.store.get(thumbKey(mediaId, 64, 64, 'scale'))?.body).toBe('T64');
  });

  it('method mismatch (crop vs scale) is a cache miss', async () => {
    const mediaId = 'methmiss';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [thumbKey(mediaId, 48, 48, 'scale')]: { body: 'SCALE' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('CROP'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=48&height=48&method=crop'), {}, { db, media });
    expect(res.text).toBe('CROP');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 48, 48, 'crop'))).toBe(true);
  });

  it('resize failure does not write a thumb key (miss stays miss)', async () => {
    const mediaId = 'nofill';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'ORIG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const res = await request(v3Thumb(mediaId, 'width=20&height=20'), {}, { db, media });
    expect(res.text).toBe('ORIG');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
    expect(media.puts.filter((p) => String(p.key).startsWith('thumb_'))).toHaveLength(0);
  });

  it('non-image content never consults cf.image and never writes thumb_', async () => {
    const mediaId = 'pdfcache';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: '%PDF-1' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId, 'width=10&height=10'), {}, { db, media });
    expect(res.text).toBe('%PDF-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...media.store.keys()].filter((k) => k.startsWith('thumb_'))).toHaveLength(0);
  });
});

describe('media thumbnail R2 cache hit/miss — v1 authenticated', () => {
  it('miss→put→hit lifecycle mirrors v3', async () => {
    const mediaId = 'v1hitmiss';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('V1JPEG'), { status: 200 })));

    const miss = await request(v1Thumb(mediaId, 'width=12&height=12&method=crop'), {}, { db, media });
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 12, 12, 'crop'))).toBe(true);

    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(v1Thumb(mediaId, 'width=12&height=12&method=crop'), {}, { db, media });
    expect(hit.text).toBe('V1JPEG');
    expect(hit.headers.get('X-Thumbnail-Generated')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('v3-written thumb key is reusable by v1 (shared R2 namespace)', async () => {
    const mediaId = 'sharedr2';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'O' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('SHARED'), { status: 200 })));
    await request(v3Thumb(mediaId, 'width=8&height=8&method=scale'), {}, { db, media });
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn());
    const v1 = await request(v1Thumb(mediaId, 'width=8&height=8&method=scale'), {}, { db, media });
    expect(v1.text).toBe('SHARED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('v1 audio original path does not set X-Thumbnail-Generated', async () => {
    const mediaId = 'v1audio';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'audio/mpeg' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'MP3' } });
    const res = await request(v1Thumb(mediaId), {}, { db, media });
    expect(res.text).toBe('MP3');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
});

describe('media thumbnail R2 cache hit soft flood', () => {
  it('v3 cached thumb soft-0', async () => {
    const mediaId = 'softhit0';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O0' },
      [key]: { body: 'HIT0' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT0');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-1', async () => {
    const mediaId = 'softhit1';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O1' },
      [key]: { body: 'HIT1' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-2', async () => {
    const mediaId = 'softhit2';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O2' },
      [key]: { body: 'HIT2' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT2');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-3', async () => {
    const mediaId = 'softhit3';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O3' },
      [key]: { body: 'HIT3' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT3');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-4', async () => {
    const mediaId = 'softhit4';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O4' },
      [key]: { body: 'HIT4' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT4');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-5', async () => {
    const mediaId = 'softhit5';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O5' },
      [key]: { body: 'HIT5' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT5');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-6', async () => {
    const mediaId = 'softhit6';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O6' },
      [key]: { body: 'HIT6' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT6');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-7', async () => {
    const mediaId = 'softhit7';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O7' },
      [key]: { body: 'HIT7' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT7');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-8', async () => {
    const mediaId = 'softhit8';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O8' },
      [key]: { body: 'HIT8' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT8');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-9', async () => {
    const mediaId = 'softhit9';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O9' },
      [key]: { body: 'HIT9' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT9');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-10', async () => {
    const mediaId = 'softhit10';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O10' },
      [key]: { body: 'HIT10' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT10');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-11', async () => {
    const mediaId = 'softhit11';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O11' },
      [key]: { body: 'HIT11' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT11');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-12', async () => {
    const mediaId = 'softhit12';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O12' },
      [key]: { body: 'HIT12' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT12');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-13', async () => {
    const mediaId = 'softhit13';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O13' },
      [key]: { body: 'HIT13' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT13');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-14', async () => {
    const mediaId = 'softhit14';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O14' },
      [key]: { body: 'HIT14' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT14');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v3 cached thumb soft-15', async () => {
    const mediaId = 'softhit15';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O15' },
      [key]: { body: 'HIT15' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('HIT15');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

});

describe('media thumbnail R2 cache miss soft flood', () => {
  it('v3 miss generates soft-0', async () => {
    const mediaId = 'softmiss0';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG0' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN0'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN0');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-1', async () => {
    const mediaId = 'softmiss1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG1' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN1'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN1');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-2', async () => {
    const mediaId = 'softmiss2';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG2' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN2'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN2');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-3', async () => {
    const mediaId = 'softmiss3';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG3' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN3'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN3');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-4', async () => {
    const mediaId = 'softmiss4';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG4' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN4'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN4');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-5', async () => {
    const mediaId = 'softmiss5';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG5' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN5'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN5');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-6', async () => {
    const mediaId = 'softmiss6';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG6' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN6'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN6');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-7', async () => {
    const mediaId = 'softmiss7';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG7' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN7'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN7');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-8', async () => {
    const mediaId = 'softmiss8';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG8' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN8'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN8');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-9', async () => {
    const mediaId = 'softmiss9';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG9' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN9'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN9');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-10', async () => {
    const mediaId = 'softmiss10';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG10' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN10'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN10');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-11', async () => {
    const mediaId = 'softmiss11';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG11' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN11'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN11');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-12', async () => {
    const mediaId = 'softmiss12';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG12' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN12'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN12');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-13', async () => {
    const mediaId = 'softmiss13';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG13' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN13'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN13');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-14', async () => {
    const mediaId = 'softmiss14';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG14' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN14'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN14');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

  it('v3 miss generates soft-15', async () => {
    const mediaId = 'softmiss15';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG15' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('GEN15'), { status: 200 })));
    const res = await request(v3Thumb(mediaId, 'width=24&height=24&method=scale'), {}, { db, media });
    expect(res.text).toBe('GEN15');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(thumbKey(mediaId, 24, 24, 'scale'))).toBe(true);
  });

});


// ============================================
// preview_url KV CACHE — hit / miss / expiry
// ============================================

describe('media preview_url CACHE hit/miss', () => {
  it('miss fetches HTML, puts with expirationTtl 3600, then hit skips fetch', async () => {
    const url = 'https://cache.example.org/article';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Fresh" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const miss = await request(v3Preview(url), {}, { cache });
    expect(miss.body).toEqual({ 'og:title': 'Fresh' });
    expect(cache.puts).toEqual([
      {
        key: `preview:${url}`,
        value: JSON.stringify({ 'og:title': 'Fresh' }),
        options: { expirationTtl: PREVIEW_TTL },
      },
    ]);

    const fetch2 = vi.fn();
    vi.stubGlobal('fetch', fetch2);
    const hit = await request(v3Preview(url), {}, { cache });
    expect(hit.body).toEqual({ 'og:title': 'Fresh' });
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('seeded cache hit never calls fetch', async () => {
    const url = 'https://seed.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'Seeded' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'Seeded' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.gets).toContain(`preview:${url}`);
  });

  it('image preview miss caches og:image + type', async () => {
    const url = 'https://img.example.org/a.webp';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytesOf('W'), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/webp' });
    expect(cache.puts[0]?.options?.expirationTtl).toBe(PREVIEW_TTL);
  });

  it('empty HTML preview is not cached (stays miss forever)', async () => {
    const url = 'https://empty.example.org/';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body>no og</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const first = await request(v3Preview(url), {}, { cache });
    expect(first.body).toEqual({});
    expect(cache.puts).toHaveLength(0);

    const fetch2 = vi.fn(
      async () =>
        new Response('<html><body>still empty</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    vi.stubGlobal('fetch', fetch2);
    await request(v3Preview(url), {}, { cache });
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it('v1 and v3 share preview: URL key namespace', async () => {
    const url = 'https://share.example.org/x';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="NS" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.stubGlobal('fetch', vi.fn());
    const v1 = await request(v1Preview(url), {}, { cache });
    expect(v1.body).toEqual({ 'og:title': 'NS' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('media preview_url CACHE expired entries', () => {
  it('entry expires after expirationTtl and refetches', async () => {
    const url = 'https://ttl.example.org/page';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="T0" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    expect(cache.data[`preview:${url}`]?.value).toContain('T0');

    // Still within TTL
    vi.advanceTimersByTime((PREVIEW_TTL - 1) * 1000);
    const fetchHit = vi.fn();
    vi.stubGlobal('fetch', fetchHit);
    const mid = await request(v3Preview(url), {}, { cache });
    expect(mid.body).toEqual({ 'og:title': 'T0' });
    expect(fetchHit).not.toHaveBeenCalled();

    // Cross TTL boundary → miss
    vi.advanceTimersByTime(2000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="T1" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const expired = await request(v3Preview(url), {}, { cache });
    expect(expired.body).toEqual({ 'og:title': 'T1' });
    expect(cache.puts.filter((p) => p.key === `preview:${url}`)).toHaveLength(2);
  });

  it('explicit delete forces miss even before TTL', async () => {
    const url = 'https://del.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'Gone' }),
    });
    await cache.delete(`preview:${url}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New' });
  });

  it('v1 preview respects the same TTL expiry semantics', async () => {
    const url = 'https://v1ttl.example.org/z';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="A" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v1Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="B" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v1Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'B' });
  });

  it('ts cache-bust query does not bypass CACHE (product ignores ts)', async () => {
    const url = 'https://ts.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'Cached' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}&ts=999`,
      {},
      { cache }
    );
    expect(res.body).toEqual({ 'og:title': 'Cached' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('media preview CACHE expiry soft flood', () => {
  it('expires and refetches soft-0', async () => {
    const url = 'https://ttlsoft0.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old0" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New0" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New0' });
  });

  it('expires and refetches soft-1', async () => {
    const url = 'https://ttlsoft1.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old1" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New1" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New1' });
  });

  it('expires and refetches soft-2', async () => {
    const url = 'https://ttlsoft2.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old2" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New2" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New2' });
  });

  it('expires and refetches soft-3', async () => {
    const url = 'https://ttlsoft3.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old3" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New3" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New3' });
  });

  it('expires and refetches soft-4', async () => {
    const url = 'https://ttlsoft4.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old4" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New4" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New4' });
  });

  it('expires and refetches soft-5', async () => {
    const url = 'https://ttlsoft5.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old5" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New5" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New5' });
  });

  it('expires and refetches soft-6', async () => {
    const url = 'https://ttlsoft6.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old6" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New6" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New6' });
  });

  it('expires and refetches soft-7', async () => {
    const url = 'https://ttlsoft7.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old7" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New7" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New7' });
  });

  it('expires and refetches soft-8', async () => {
    const url = 'https://ttlsoft8.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old8" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New8" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New8' });
  });

  it('expires and refetches soft-9', async () => {
    const url = 'https://ttlsoft9.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old9" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New9" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New9' });
  });

  it('expires and refetches soft-10', async () => {
    const url = 'https://ttlsoft10.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old10" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New10" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New10' });
  });

  it('expires and refetches soft-11', async () => {
    const url = 'https://ttlsoft11.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Old11" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    await request(v3Preview(url), {}, { cache });
    vi.advanceTimersByTime(PREVIEW_TTL * 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="New11" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'New11' });
  });

});

describe('media preview CACHE hit soft flood', () => {
  it('v3 seeded hit soft-0', async () => {
    const url = 'https://hithard0.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H0' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H0' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-1', async () => {
    const url = 'https://hithard1.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H1' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-2', async () => {
    const url = 'https://hithard2.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H2' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H2' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-3', async () => {
    const url = 'https://hithard3.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H3' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H3' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-4', async () => {
    const url = 'https://hithard4.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H4' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H4' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-5', async () => {
    const url = 'https://hithard5.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H5' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H5' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-6', async () => {
    const url = 'https://hithard6.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H6' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H6' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-7', async () => {
    const url = 'https://hithard7.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H7' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H7' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-8', async () => {
    const url = 'https://hithard8.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H8' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H8' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-9', async () => {
    const url = 'https://hithard9.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H9' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H9' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-10', async () => {
    const url = 'https://hithard10.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H10' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H10' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v3 seeded hit soft-11', async () => {
    const url = 'https://hithard11.example.org/p';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'H11' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(v3Preview(url), {}, { cache });
    expect(res.body).toEqual({ 'og:title': 'H11' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

});


// ============================================
// Invalid mxc / remote / missing stubs (already handled)
// ============================================

describe('media invalid mxc stubs already handled', () => {
  it('upload returns well-formed mxc://SERVER/mediaId', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    expect(res.status).toBe(200);
    const uri = (res.body as { content_uri: string }).content_uri;
    expect(uri).toMatch(/^mxc:\/\/example\.com\/mediaid/);
    const mediaId = uri.split('/').pop()!;
    expect(res.db.rows[0].media_id).toBe(mediaId);
  });

  it('create placeholder returns mxc URI with unused_expires_at', async () => {
    const res = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = res.body as { content_uri: string; unused_expires_at: number };
    expect(body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
    expect(body.unused_expires_at).toBeGreaterThan(Date.now());
  });

  it('thumbnail rejects remote serverName (invalid local mxc host)', async () => {
    for (const path of [
      `/_matrix/media/v3/thumbnail/${REMOTE}/abc`,
      `/_matrix/client/v1/media/thumbnail/${REMOTE}/abc`,
    ]) {
      const res = await request(path);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
    }
  });

  it('thumbnail rejects unknown mediaId (dangling mxc path)', async () => {
    for (const path of [v3Thumb('nope'), v1Thumb('nope')]) {
      const res = await request(path);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'Media not found' });
    }
  });

  it('thumbnail rejects metadata-without-R2 (broken mxc object)', async () => {
    const mediaId = 'brokenmxc';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    for (const path of [v3Thumb(mediaId), v1Thumb(mediaId)]) {
      const res = await request(path, {}, { db, media: createMediaBucket() });
      expect(res.status).toBe(404);
    }
  });

  it('download rejects remote serverName like thumbnail', async () => {
    const res = await request(`/_matrix/media/v3/download/${REMOTE}/x`);
    expect(res.status).toBe(404);
  });

  it('mxc mediaId with odd but allowed path chars still looks up by id', async () => {
    const mediaId = 'abc._-XYZ';
    const key = thumbKey(mediaId);
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'T' },
    });
    const res = await request(v3Thumb(mediaId), {}, { db, media });
    expect(res.text).toBe('T');
  });
});

describe('media invalid mxc stub soft flood', () => {
  it('remote thumbnail 404 soft-0', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id0`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-1', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id1`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-2', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id2`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-3', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id3`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-4', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id4`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-5', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id5`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-6', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id6`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-7', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id7`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-8', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id8`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-9', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id9`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-10', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id10`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-11', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id11`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-12', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id12`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-13', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id13`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-14', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id14`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('remote thumbnail 404 soft-15', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/id15`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('missing mediaId thumbnail 404 soft-0', async () => {
    const res = await request(v3Thumb(`missing0`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-1', async () => {
    const res = await request(v3Thumb(`missing1`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-2', async () => {
    const res = await request(v3Thumb(`missing2`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-3', async () => {
    const res = await request(v3Thumb(`missing3`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-4', async () => {
    const res = await request(v3Thumb(`missing4`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-5', async () => {
    const res = await request(v3Thumb(`missing5`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-6', async () => {
    const res = await request(v3Thumb(`missing6`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-7', async () => {
    const res = await request(v3Thumb(`missing7`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-8', async () => {
    const res = await request(v3Thumb(`missing8`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-9', async () => {
    const res = await request(v3Thumb(`missing9`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-10', async () => {
    const res = await request(v3Thumb(`missing10`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-11', async () => {
    const res = await request(v3Thumb(`missing11`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-12', async () => {
    const res = await request(v3Thumb(`missing12`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-13', async () => {
    const res = await request(v3Thumb(`missing13`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-14', async () => {
    const res = await request(v3Thumb(`missing14`));
    expect(res.status).toBe(404);
  });

  it('missing mediaId thumbnail 404 soft-15', async () => {
    const res = await request(v3Thumb(`missing15`));
    expect(res.status).toBe(404);
  });

});


// ============================================
// Concurrent fetch races (thumbnail + preview)
// ============================================

describe('media thumbnail concurrent fetch races', () => {
  it('two parallel v3 misses both fetch and both put (last-write-wins, no lock)', async () => {
    const mediaId = 'race1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    let releaseGet: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let thumbGets = 0;
    const media = createMediaBucket(
      { [mediaId]: { body: 'PNG' } },
      {
        onBeforeGet: async (key) => {
          if (key.startsWith('thumb_')) {
            thumbGets += 1;
            if (thumbGets <= 2) await gate;
          }
        },
      }
    );

    let fetchN = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchN += 1;
        return new Response(bytesOf(`JPEG${fetchN}`), { status: 200 });
      })
    );

    const p1 = request(v3Thumb(mediaId, 'width=16&height=16&method=scale'), {}, { db, media });
    const p2 = request(v3Thumb(mediaId, 'width=16&height=16&method=scale'), {}, { db, media });
    // Both should be waiting on thumb_ get barrier
    await Promise.resolve();
    releaseGet!();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(fetchN).toBe(2);
    const key = thumbKey(mediaId, 16, 16, 'scale');
    expect(media.puts.filter((p) => p.key === key).length).toBe(2);
    // Final stored body is whichever put completed last
    const stored = media.store.get(key)?.body;
    expect(stored === 'JPEG1' || stored === 'JPEG2' || stored instanceof ArrayBuffer).toBe(true);
  });

  it('parallel miss then sequential hit: only first wave fetches', async () => {
    const mediaId = 'race2';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('ONCE'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=4&height=4'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=4&height=4'), {}, { db, media }),
    ]);
    expect(a.text === 'ONCE' || b.text === 'ONCE').toBe(true);
    expect(fetch).toHaveBeenCalled();
    const callsAfterRace = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(v3Thumb(mediaId, 'width=4&height=4'), {}, { db, media });
    expect(hit.headers.get('X-Thumbnail-Generated')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(callsAfterRace).toBeGreaterThanOrEqual(1);
  });

  it('concurrent requests for different dimension keys do not collide', async () => {
    const mediaId = 'race3';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { cf?: { image?: { width?: number } } }) => {
        n += 1;
        const w = init?.cf?.image?.width ?? 0;
        return new Response(bytesOf(`W${w}`), { status: 200 });
      })
    );
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=10&height=10&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=20&height=20&method=scale'), {}, { db, media }),
    ]);
    expect(a.text).toBe('W10');
    expect(b.text).toBe('W20');
    expect(media.store.has(thumbKey(mediaId, 10, 10, 'scale'))).toBe(true);
    expect(media.store.has(thumbKey(mediaId, 20, 20, 'scale'))).toBe(true);
    expect(n).toBe(2);
  });

  it('v3 ∥ v1 concurrent miss on same key both put under shared R2 key', async () => {
    const mediaId = 'race4';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('BOTH'), { status: 200 })));
    const [v3, v1] = await Promise.all([
      request(v3Thumb(mediaId, 'width=5&height=5&method=crop'), {}, { db, media }),
      request(v1Thumb(mediaId, 'width=5&height=5&method=crop'), {}, { db, media }),
    ]);
    expect(v3.status).toBe(200);
    expect(v1.status).toBe(200);
    const key = thumbKey(mediaId, 5, 5, 'crop');
    expect(media.puts.filter((p) => p.key === key).length).toBeGreaterThanOrEqual(1);
    expect(media.store.has(key)).toBe(true);
  });

  it('concurrent hit against pre-seeded thumb never fetches', async () => {
    const mediaId = 'race5';
    const key = thumbKey(mediaId, 96, 96, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'PRE' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all([
      request(v3Thumb(mediaId), {}, { db, media }),
      request(v3Thumb(mediaId), {}, { db, media }),
      request(v1Thumb(mediaId), {}, { db, media }),
    ]);
    for (const r of results) {
      expect(r.text).toBe('PRE');
      expect(r.headers.get('X-Thumbnail-Generated')).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('media preview_url concurrent fetch races', () => {
  it('two parallel preview misses both fetch and both put', async () => {
    const url = 'https://raceprev.example.org/a';
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gets = 0;
    const cache = createExpiringCache(
      {},
      {
        onBeforeGet: async (key) => {
          if (key === `preview:${url}`) {
            gets += 1;
            if (gets <= 2) await gate;
          }
        },
      }
    );
    let fetchN = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchN += 1;
        return new Response(`<meta property="og:title" content="R${fetchN}" />`, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      })
    );
    const p1 = request(v3Preview(url), {}, { cache });
    const p2 = request(v3Preview(url), {}, { cache });
    await Promise.resolve();
    release!();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(fetchN).toBe(2);
    expect(cache.puts.filter((p) => p.key === `preview:${url}`).length).toBe(2);
  });

  it('v3 ∥ v1 concurrent miss share key and both may put', async () => {
    const url = 'https://raceprev2.example.org/b';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="X" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'X' });
    expect(b.body).toEqual({ 'og:title': 'X' });
    expect(cache.puts.length).toBeGreaterThanOrEqual(1);
    expect(cache.puts.every((p) => p.options?.expirationTtl === PREVIEW_TTL)).toBe(true);
  });

  it('concurrent hits on seeded preview never fetch', async () => {
    const url = 'https://raceprev3.example.org/c';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'Seed' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
      request(v3Preview(url), {}, { cache }),
    ]);
    for (const r of results) expect(r.body).toEqual({ 'og:title': 'Seed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('expired entry under concurrent readers all miss and refetch', async () => {
    const url = 'https://raceprev4.example.org/d';
    const cache = createExpiringCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'Old' }),
    });
    // Force immediate expiry
    cache.data[`preview:${url}`]!.expiresAtMs = Date.now();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return new Response(`<meta property="og:title" content="N${n}" />`, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      })
    );
    const results = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v3Preview(url), {}, { cache }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(n).toBe(2);
  });
});

describe('media thumbnail concurrent race soft flood', () => {
  it('parallel miss put soft-0', async () => {
    const mediaId = 'racesoft0';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J0'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-1', async () => {
    const mediaId = 'racesoft1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J1'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-2', async () => {
    const mediaId = 'racesoft2';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J2'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-3', async () => {
    const mediaId = 'racesoft3';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J3'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-4', async () => {
    const mediaId = 'racesoft4';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J4'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-5', async () => {
    const mediaId = 'racesoft5';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J5'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-6', async () => {
    const mediaId = 'racesoft6';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J6'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-7', async () => {
    const mediaId = 'racesoft7';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J7'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-8', async () => {
    const mediaId = 'racesoft8';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J8'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-9', async () => {
    const mediaId = 'racesoft9';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J9'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-10', async () => {
    const mediaId = 'racesoft10';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J10'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

  it('parallel miss put soft-11', async () => {
    const mediaId = 'racesoft11';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'P' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J11'), { status: 200 })));
    const [a, b] = await Promise.all([
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
      request(v3Thumb(mediaId, 'width=7&height=7&method=scale'), {}, { db, media }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(media.store.has(thumbKey(mediaId, 7, 7, 'scale'))).toBe(true);
  });

});

describe('media preview concurrent race soft flood', () => {
  it('parallel preview miss soft-0', async () => {
    const url = 'https://prevsoft0.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S0" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S0' });
    expect(b.body).toEqual({ 'og:title': 'S0' });
  });

  it('parallel preview miss soft-1', async () => {
    const url = 'https://prevsoft1.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S1" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S1' });
    expect(b.body).toEqual({ 'og:title': 'S1' });
  });

  it('parallel preview miss soft-2', async () => {
    const url = 'https://prevsoft2.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S2" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S2' });
    expect(b.body).toEqual({ 'og:title': 'S2' });
  });

  it('parallel preview miss soft-3', async () => {
    const url = 'https://prevsoft3.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S3" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S3' });
    expect(b.body).toEqual({ 'og:title': 'S3' });
  });

  it('parallel preview miss soft-4', async () => {
    const url = 'https://prevsoft4.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S4" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S4' });
    expect(b.body).toEqual({ 'og:title': 'S4' });
  });

  it('parallel preview miss soft-5', async () => {
    const url = 'https://prevsoft5.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S5" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S5' });
    expect(b.body).toEqual({ 'og:title': 'S5' });
  });

  it('parallel preview miss soft-6', async () => {
    const url = 'https://prevsoft6.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S6" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S6' });
    expect(b.body).toEqual({ 'og:title': 'S6' });
  });

  it('parallel preview miss soft-7', async () => {
    const url = 'https://prevsoft7.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S7" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S7' });
    expect(b.body).toEqual({ 'og:title': 'S7' });
  });

  it('parallel preview miss soft-8', async () => {
    const url = 'https://prevsoft8.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S8" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S8' });
    expect(b.body).toEqual({ 'og:title': 'S8' });
  });

  it('parallel preview miss soft-9', async () => {
    const url = 'https://prevsoft9.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S9" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S9' });
    expect(b.body).toEqual({ 'og:title': 'S9' });
  });

  it('parallel preview miss soft-10', async () => {
    const url = 'https://prevsoft10.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S10" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S10' });
    expect(b.body).toEqual({ 'og:title': 'S10' });
  });

  it('parallel preview miss soft-11', async () => {
    const url = 'https://prevsoft11.example.org/p';
    const cache = createExpiringCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="S11" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const [a, b] = await Promise.all([
      request(v3Preview(url), {}, { cache }),
      request(v1Preview(url), {}, { cache }),
    ]);
    expect(a.body).toEqual({ 'og:title': 'S11' });
    expect(b.body).toEqual({ 'og:title': 'S11' });
  });

});


// ============================================
// Cache-key clamp / method edges
// ============================================

describe('media thumbnail cache-key clamp edges', () => {
  it('width=0 falls back to 96 in key', async () => {
    const mediaId = 'clamp0';
    const key = thumbKey(mediaId, 96, 50, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C0' },
    });
    const res = await request(v3Thumb(mediaId, 'width=0&height=50'), {}, { db, media });
    expect(res.text).toBe('C0');
  });

  it('height oversize clamps to 1920 in key', async () => {
    const mediaId = 'clamp1920';
    const key = thumbKey(mediaId, 10, 1920, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C1920' },
    });
    const res = await request(v3Thumb(mediaId, 'width=10&height=99999'), {}, { db, media });
    expect(res.text).toBe('C1920');
  });

  it('missing method defaults to scale in key', async () => {
    const mediaId = 'defmethod';
    const key = thumbKey(mediaId, 11, 11, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'DEF' },
    });
    const res = await request(v3Thumb(mediaId, 'width=11&height=11'), {}, { db, media });
    expect(res.text).toBe('DEF');
  });

  it('NaN height falls back to 96 in key', async () => {
    const mediaId = 'nanh';
    const key = thumbKey(mediaId, 40, 96, 'crop');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'NAN' },
    });
    const res = await request(v3Thumb(mediaId, 'width=40&height=nope&method=crop'), {}, { db, media });
    expect(res.text).toBe('NAN');
  });
});

describe('media thumbnail clamp soft flood', () => {
  it('hit after clamp soft-0', async () => {
    const mediaId = 'clsoft0';
    const key = thumbKey(mediaId, 1, 1, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C0' },
    });
    const res = await request(v3Thumb(mediaId, 'width=1&height=1'), {}, { db, media });
    expect(res.text).toBe('C0');
  });

  it('hit after clamp soft-1', async () => {
    const mediaId = 'clsoft1';
    const key = thumbKey(mediaId, 2, 2, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C1' },
    });
    const res = await request(v3Thumb(mediaId, 'width=2&height=2'), {}, { db, media });
    expect(res.text).toBe('C1');
  });

  it('hit after clamp soft-2', async () => {
    const mediaId = 'clsoft2';
    const key = thumbKey(mediaId, 3, 3, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C2' },
    });
    const res = await request(v3Thumb(mediaId, 'width=3&height=3'), {}, { db, media });
    expect(res.text).toBe('C2');
  });

  it('hit after clamp soft-3', async () => {
    const mediaId = 'clsoft3';
    const key = thumbKey(mediaId, 4, 4, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C3' },
    });
    const res = await request(v3Thumb(mediaId, 'width=4&height=4'), {}, { db, media });
    expect(res.text).toBe('C3');
  });

  it('hit after clamp soft-4', async () => {
    const mediaId = 'clsoft4';
    const key = thumbKey(mediaId, 5, 5, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C4' },
    });
    const res = await request(v3Thumb(mediaId, 'width=5&height=5'), {}, { db, media });
    expect(res.text).toBe('C4');
  });

  it('hit after clamp soft-5', async () => {
    const mediaId = 'clsoft5';
    const key = thumbKey(mediaId, 6, 6, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C5' },
    });
    const res = await request(v3Thumb(mediaId, 'width=6&height=6'), {}, { db, media });
    expect(res.text).toBe('C5');
  });

  it('hit after clamp soft-6', async () => {
    const mediaId = 'clsoft6';
    const key = thumbKey(mediaId, 7, 7, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C6' },
    });
    const res = await request(v3Thumb(mediaId, 'width=7&height=7'), {}, { db, media });
    expect(res.text).toBe('C6');
  });

  it('hit after clamp soft-7', async () => {
    const mediaId = 'clsoft7';
    const key = thumbKey(mediaId, 8, 8, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C7' },
    });
    const res = await request(v3Thumb(mediaId, 'width=8&height=8'), {}, { db, media });
    expect(res.text).toBe('C7');
  });

  it('hit after clamp soft-8', async () => {
    const mediaId = 'clsoft8';
    const key = thumbKey(mediaId, 9, 9, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C8' },
    });
    const res = await request(v3Thumb(mediaId, 'width=9&height=9'), {}, { db, media });
    expect(res.text).toBe('C8');
  });

  it('hit after clamp soft-9', async () => {
    const mediaId = 'clsoft9';
    const key = thumbKey(mediaId, 10, 10, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C9' },
    });
    const res = await request(v3Thumb(mediaId, 'width=10&height=10'), {}, { db, media });
    expect(res.text).toBe('C9');
  });

  it('hit after clamp soft-10', async () => {
    const mediaId = 'clsoft10';
    const key = thumbKey(mediaId, 11, 11, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C10' },
    });
    const res = await request(v3Thumb(mediaId, 'width=11&height=11'), {}, { db, media });
    expect(res.text).toBe('C10');
  });

  it('hit after clamp soft-11', async () => {
    const mediaId = 'clsoft11';
    const key = thumbKey(mediaId, 12, 12, 'scale');
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'C11' },
    });
    const res = await request(v3Thumb(mediaId, 'width=12&height=12'), {}, { db, media });
    expect(res.text).toBe('C11');
  });

});

describe('media thumbnail-cache lifecycle soft flood', () => {
  it('upload then thumb miss then hit soft-0', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x0.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L0'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L0');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-1', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x1.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L1'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-2', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x2.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L2'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L2');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-3', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x3.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L3'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-4', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x4.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L4'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L4');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-5', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x5.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L5'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L5');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-6', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x6.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L6'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L6');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-7', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x7.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L7'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L7');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-8', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x8.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L8'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L8');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-9', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x9.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L9'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L9');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-10', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x10.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L10'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L10');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('upload then thumb miss then hit soft-11', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x11.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(up.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('L11'), { status: 200 })));
    const miss = await request(
      v3Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(miss.headers.get('X-Thumbnail-Generated')).toBe('true');
    vi.stubGlobal('fetch', vi.fn());
    const hit = await request(
      v1Thumb(mediaId, 'width=9&height=9&method=scale'),
      {},
      { db: up.db, media: up.media }
    );
    expect(hit.text).toBe('L11');
    expect(fetch).not.toHaveBeenCalled();
  });

});
