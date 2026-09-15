/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #341 — niche media softfail
 * soft residual *seventh-wave* concurrent-race leftovers (tip past #341 sixth).
 *
 * Unsaturated by waves #301/#305/#318/#327/#334/#341:
 *   never fee0 / fef0 / fe90 / fea0 / feb0 / ff01 / ff0e / 2001:0db8 /
 *     10.255.255.1 / ::ffff:192.168.0.1 / ::ffff:c0a8:1 / 127.0.0.2
 *     under soft residual PA,
 *   never preview nonstandard 8000/7000/9090/10443,
 *   never irc/ssh/git/magnet schemes,
 *   never case-mutated supported MIME Audio/MP3|Audio/WebM|IMAGE/WEBP|
 *     VIDEO/WEBM|AUDIO/MP3|Image/Jpeg.
 *
 * Gap table (why leftover after #341 sixth):
 *   residual SSRF (fee/fef site-local / fe9–feb link-local / ff01/ff0e /
 *     2001:0db8 / 10.255 / mapped 192.168 / 127.0.0.2) ∥ cached
 *   residual preview nonstandard ports 8000/7000/9090/10443 ∥ cached
 *   residual schemes (irc / ssh / git / magnet) ∥ cached
 *   case-mutated supported MIME (Audio/MP3, Audio/WebM, …) ∥ ok
 *   multi: fee0-SSRF + preview-port + scheme + case-MIME ∥ oks
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
const SERVER = 'example.com';
const PREVIEW_OK_URL = 'https://example.org/page';
const PREVIEW_CACHE_KEY = `preview:${PREVIEW_OK_URL}`;
const PREVIEW_CACHED = { 'og:title': 'Cached Example', 'og:site_name': 'example.org' };

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
  vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Residual SSRF (fee/fef / fe9–feb / ff01/ff0e / 0db8 / 10.255 / mapped 192.168) ∥ cached
// ---------------------------------------------------------------------------

describe('media seventh-wave concurrent residual SSRF ∥ cached after #341', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'ipv6 site-local fee0',
      url: 'http://[fee0::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 site-local fef0',
      url: 'http://[fef0::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local fe90',
      url: 'http://[fe90::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local fea0',
      url: 'http://[fea0::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local feb0',
      url: 'http://[feb0::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 multicast ff01',
      url: 'http://[ff01::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 multicast ff0e',
      url: 'http://[ff0e::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'docs prefix 2001:0db8',
      url: 'http://[2001:0db8::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 10.255',
      url: 'http://10.255.255.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped dotted ::ffff:192.168.0.1',
      url: 'http://[::ffff:192.168.0.1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped hex ::ffff:c0a8:1',
      url: 'http://[::ffff:c0a8:1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'loopback 127.0.0.2',
      url: 'http://127.0.0.2/',
      error: 'Access to internal IP addresses is not allowed',
    },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} ∥ cached — exact soft under Promise.all`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(c.url)}`,
          {},
          env
        ),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({ errcode: 'M_UNKNOWN', error: c.error });
      expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    });

    it(`v1 ${c.label} ∥ v3 cached under race`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(
          `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(c.url)}`,
          {},
          env
        ),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.error).toBe(c.error);
      expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    });
  }

  it('multi residual SSRF softs ∥ one cached under race', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[fee0::1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://[ff01::1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://10.255.255.1/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://127.0.0.2/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    expect(
      results
        .filter((r) => r.status === 400)
        .every((r) => r.body.error === 'Access to internal IP addresses is not allowed')
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Residual preview nonstandard ports 8000/7000/9090/10443 ∥ cached
// ---------------------------------------------------------------------------

describe('media seventh-wave concurrent residual ports ∥ cached after #341', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'preview nonstandard 8000',
      url: 'https://example.org:8000/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 7000',
      url: 'https://example.org:7000/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 9090',
      url: 'https://example.org:9090/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 10443',
      url: 'https://example.org:10443/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} ∥ cached — exact soft under Promise.all`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(c.url)}`,
          {},
          env
        ),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({ errcode: 'M_UNKNOWN', error: c.error });
      expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    });

    it(`v1 ${c.label} ∥ v3 cached under race`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(
          `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(c.url)}`,
          {},
          env
        ),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.error).toBe(c.error);
      expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    });
  }

  it('multi preview-port softs ∥ one cached under race', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:8000/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('https://example.org:7000/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:9090/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(
      results
        .filter((r) => r.status === 400)
        .every(
          (r) =>
            r.body.error ===
            'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview'
        )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Residual schemes (irc/ssh/git/magnet) ∥ cached
// ---------------------------------------------------------------------------

describe('media seventh-wave concurrent residual schemes ∥ cached after #341', () => {
  const cases: Array<{ label: string; url: string }> = [
    { label: 'irc', url: 'irc://example.org/' },
    { label: 'ssh', url: 'ssh://example.org/' },
    { label: 'git', url: 'git://example.org/' },
    { label: 'magnet', url: 'magnet:?xt=urn:btih:deadbeef' },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} scheme ∥ cached — Only HTTP/HTTPS pin`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(c.url)}`,
          {},
          env
        ),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({
        errcode: 'M_UNKNOWN',
        error: 'Only HTTP and HTTPS protocols are allowed',
      });
      expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    });
  }

  it('multi residual schemes ∥ cached under race', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('irc://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('ssh://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('git://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('magnet:?xt=urn:btih:deadbeef')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    expect(
      results
        .filter((r) => r.status === 400)
        .every((r) => r.body.error === 'Only HTTP and HTTPS protocols are allowed')
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case-mutated *supported* MIME soft (leftovers after #341 sixth) ∥ ok
// ---------------------------------------------------------------------------

describe('media seventh-wave concurrent case-mutated supported MIME soft ∥ ok after #341', () => {
  it('v3 Audio/MP3 ∥ audio/mp3 — case-sensitive whitelist pin', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('mp3');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'Audio/MP3', 'Content-Length': '4' },
        body: bytesOf('bad!'),
      }, env),
      request('/_matrix/media/v3/upload?filename=ok.mp3', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mp3', 'Content-Length': String(okBody.byteLength) },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: Audio/MP3',
    });
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
  });

  it('v1 Audio/WebM ∥ v3 audio/webm under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'Audio/WebM', 'Content-Length': '2' },
        body: bytesOf('no'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm', 'Content-Length': '3' },
        body: bytesOf('wbm'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: Audio/WebM');
  });

  for (const softType of [
    'IMAGE/WEBP',
    'VIDEO/WEBM',
    'AUDIO/MP3',
    'Image/Jpeg',
  ]) {
    it(`case-mutated supported MIME '${softType}' flood ∥ ok`, async () => {
      const db = createMediaDb();
      const media = createMediaBucket();
      const env = envFor({ db, media });
      const results = await Promise.all([
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': softType, 'Content-Length': '1' },
          body: bytesOf('x'),
        }, env),
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
          body: bytesOf('y'),
        }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body.error).toBe(`Unsupported content type: ${softType}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-error seventh-wave soft isolation
// ---------------------------------------------------------------------------

describe('media seventh-wave concurrent multi-error soft isolation after #341', () => {
  it('fee0-SSRF + preview-port + scheme + case-MIME ∥ oks', async () => {
    const { db, media } = seedLocalDownload('loc7');
    const cache = seedPreviewCache();
    const env = envFor({ db, media, cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[fee0::1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:8000/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('irc://example.org/')}`,
        {},
        env
      ),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'Audio/MP3', 'Content-Length': '1' },
        body: bytesOf('z'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
        body: bytesOf('ok'),
      }, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc7`, {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: Audio/MP3');
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Access to internal IP addresses is not allowed',
        'Only HTTP and HTTPS protocols are allowed',
        'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`seventh-wave multi soft isolation flood-${i}`, async () => {
      const cache = seedPreviewCache();
      const db = createMediaDb();
      const media = createMediaBucket();
      const env = envFor({ db, media, cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[ff0e::1]/')}`,
          {},
          env
        ),
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'Audio/WebM', 'Content-Length': '1' },
          body: bytesOf('x'),
        }, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('git://example.org/')}`,
          {},
          env
        ),
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
          body: bytesOf('y'),
        }, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.status === 400)).toHaveLength(2);
      expect(softBody(results, 403).body.error).toBe('Unsupported content type: Audio/WebM');
    });
  }
});
