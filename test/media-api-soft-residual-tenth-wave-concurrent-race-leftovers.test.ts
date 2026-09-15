/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #397 — niche media soft
 * residual *tenth-wave* concurrent-race leftovers (tip past #397 ninth / 0d60aaa).
 *
 * Unsaturated by waves #301/#305/#318/#327/#334/#341/#357/#371/#397:
 *   never 127.64.0.1 / 10.64.0.1 / 192.168.64.1 / 172.28.0.1 /
 *     ::ffff:10.64.0.1 / ::ffff:a40:1 / ::ffff:169.254.64.1 /
 *     ff04 / ff0b / fe84 / feb8 / fd40 / 2001:db8:a /
 *     etcd.kubernetes.default.svc.cluster.local / canary.metadata.google.internal /
 *     worker.internal / baz.local / 0.64.0.1 under soft PA,
 *   never preview nonstandard 1337/2345/4567/6789/9999/18000,
 *   never ldaps/imap/pop3/smtp/afp/rmi/jdbc/webdav schemes,
 *   never case-mutated supported MIME IMAGE/Png|AUDIO/Wav|Text/plain|
 *     Video/Webm|Application/OCTET-STREAM|IMAGE/Webp.
 *
 * Gap table (why leftover after #397 ninth):
 *   residual SSRF (mid-low loopback / 10.64 / 192.168.64 / 172.28 /
 *     mapped 10.64 + link-local / ff04 / ff0b / fe84 / feb8 / fd40 /
 *     2001:db8:a / k8s cluster.local etcd + canary metadata + .internal +
 *     .local / 0.64.0.1) ∥ cached
 *   residual preview nonstandard ports (1337/2345/4567/6789/9999/18000) ∥ cached
 *   residual schemes (ldaps / imap / pop3 / smtp / afp / rmi / jdbc / webdav) ∥ cached
 *   case-mutated supported MIME (IMAGE/Png, AUDIO/Wav, Text/plain, …) ∥ ok
 *   multi: mapped-SSRF + port + scheme + case-MIME ∥ oks
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
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Residual SSRF (mid-low loopback / 10.64 / mapped 10.64 / ff04 / fe84 / …) ∥ cached
// ---------------------------------------------------------------------------

describe('media tenth-wave concurrent residual SSRF ∥ cached after #397', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'loopback 127.64.0.1',
      url: 'http://127.64.0.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 10.64.0.1',
      url: 'http://10.64.0.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 192.168.64.1',
      url: 'http://192.168.64.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 172.28',
      url: 'http://172.28.0.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped dotted ::ffff:10.64.0.1',
      url: 'http://[::ffff:10.64.0.1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped hex ::ffff:a40:1',
      url: 'http://[::ffff:a40:1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped dotted ::ffff:169.254.64.1',
      url: 'http://[::ffff:169.254.64.1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 multicast ff04',
      url: 'http://[ff04::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 multicast ff0b',
      url: 'http://[ff0b::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local fe84',
      url: 'http://[fe84::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local feb8',
      url: 'http://[feb8::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 ula fd40',
      url: 'http://[fd40::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'docs prefix 2001:db8:a',
      url: 'http://[2001:db8:a::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'etcd.kubernetes.default.svc.cluster.local subdomain',
      url: 'http://etcd.kubernetes.default.svc.cluster.local/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'canary.metadata.google.internal subdomain',
      url: 'http://canary.metadata.google.internal/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'worker.internal hostname',
      url: 'http://worker.internal/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'baz.local mDNS',
      url: 'http://baz.local/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'current-network 0.64.0.1',
      url: 'http://0.64.0.1/',
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://127.64.0.1/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://[ff04::1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://etcd.kubernetes.default.svc.cluster.local/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://172.28.0.1/')}`,
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
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Access to internal hostnames is not allowed',
        'Access to internal IP addresses is not allowed',
        'Access to internal IP addresses is not allowed',
        'Access to internal IP addresses is not allowed',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Residual preview nonstandard ports 1337/2345/4567/6789/9999/18000 ∥ cached
// ---------------------------------------------------------------------------

describe('media tenth-wave concurrent residual ports ∥ cached after #397', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'preview nonstandard 1337',
      url: 'https://example.org:1337/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 2345',
      url: 'https://example.org:2345/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 4567',
      url: 'https://example.org:4567/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 6789',
      url: 'https://example.org:6789/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 9999',
      url: 'https://example.org:9999/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 18000',
      url: 'https://example.org:18000/',
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
  }

  it('multi port softs ∥ one cached under race', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:1337/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('https://example.org:2345/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:4567/')}`,
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
// Residual schemes (ldaps/imap/pop3/smtp/afp/rmi/jdbc/webdav) ∥ cached
// ---------------------------------------------------------------------------

describe('media tenth-wave concurrent residual schemes ∥ cached after #397', () => {
  const cases: Array<{ label: string; url: string }> = [
    { label: 'ldaps', url: 'ldaps://example.org/' },
    { label: 'imap', url: 'imap://example.org/' },
    { label: 'pop3', url: 'pop3://example.org/' },
    { label: 'smtp', url: 'smtp://example.org/' },
    { label: 'afp', url: 'afp://example.org/' },
    { label: 'rmi', url: 'rmi://example.org/' },
    { label: 'jdbc', url: 'jdbc:postgresql://example.org/db' },
    { label: 'webdav', url: 'webdav://example.org/' },
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('ldaps://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('imap://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('smtp://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('webdav://example.org/')}`,
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
// Case-mutated *supported* MIME soft (leftovers after #397 ninth) ∥ ok
// ---------------------------------------------------------------------------

describe('media tenth-wave concurrent case-mutated supported MIME soft ∥ ok after #397', () => {
  it('v3 IMAGE/Png ∥ image/png — case-sensitive whitelist pin', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('png!');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'IMAGE/Png', 'Content-Length': '4' },
        body: bytesOf('bad!'),
      }, env),
      request('/_matrix/media/v3/upload?filename=ok.png', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(okBody.byteLength) },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: IMAGE/Png',
    });
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
  });

  it('v1 AUDIO/Wav ∥ v3 audio/wav under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'AUDIO/Wav', 'Content-Length': '2' },
        body: bytesOf('no'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav', 'Content-Length': '3' },
        body: bytesOf('ok\n'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: AUDIO/Wav');
  });

  for (const softType of [
    'Text/plain',
    'Video/Webm',
    'Application/OCTET-STREAM',
    'IMAGE/Webp',
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
// Multi-error tenth-wave soft isolation
// ---------------------------------------------------------------------------

describe('media tenth-wave concurrent multi-error soft isolation after #397', () => {
  it('mapped-10.64-SSRF + port + scheme + case-MIME ∥ oks', async () => {
    const { db, media } = seedLocalDownload('loc10');
    const cache = seedPreviewCache();
    const env = envFor({ db, media, cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::ffff:10.64.0.1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:1337/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('ldaps://example.org/')}`,
        {},
        env
      ),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'IMAGE/Png', 'Content-Length': '1' },
        body: bytesOf('z'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
        body: bytesOf('ok'),
      }, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc10`, {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: IMAGE/Png');
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
    it(`tenth-wave multi soft isolation flood-${i}`, async () => {
      const cache = seedPreviewCache();
      const db = createMediaDb();
      const media = createMediaBucket();
      const env = envFor({ db, media, cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[feb8::1]/')}`,
          {},
          env
        ),
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'IMAGE/Webp', 'Content-Length': '1' },
          body: bytesOf('x'),
        }, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('smtp://example.org/')}`,
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
      expect(softBody(results, 403).body.error).toBe('Unsupported content type: IMAGE/Webp');
    });
  }
});
