/**
 * TOKENMAXX HEAVY tip-relaunch of closed #383 niches onto tip 320fea0 (post
 * #380) — niche media soft residual *ninth-wave* concurrent-race leftovers
 * past merged #371 eighth (and tip-shift past #380 room-cache/hibernation).
 *
 * Unsaturated by waves #301/#305/#318/#327/#334/#341/#357/#371:
 *   never 127.128.0.1 / 10.128.255.1 / 192.168.128.255 / 172.18.255.1 /
 *     ::ffff:127.0.0.1 / ::ffff:c0a8:80ff / ::ffff:7f80:1 / ff03 / ff08 /
 *     fe80 / fe91 / fea1 / febf / fec1 / fee1 / fc01 / fd00 / 2001:db8:ffff /
 *     svc.kubernetes.default.svc.cluster.local / foo.metadata.google.internal /
 *     z.local / a.internal / xyz.ip6-localhost / abc.localhost.localdomain /
 *     0.1.0.1 under soft PA,
 *   never preview nonstandard 3333/7777/16000/2345/1111/20000,
 *   never ftp/file/sip/xmpp/mqtt/coap/rsync/tftp/news schemes,
 *   never case-mutated supported MIME IMAGE/GIF|Image/Gif|AUDIO/MPEG|
 *     AUDIO/OGG|AUDIO/WEBM|VIDEO/WebM|APPLICATION/OCTET-STREAM|Application/Pdf.
 *
 * Gap table (why leftover after #371 eighth):
 *   residual SSRF (mid loopback / 10.128 / 192.168.128 / 172.18 /
 *     mapped loopback+192.168 / ff03 / ff08 / fe80 / fe91 / fea1 / febf /
 *     fec1 / fee1 / fc01 / fd00 / 2001:db8:ffff / k8s cluster.local +
 *     metadata.google.internal + .local/.internal + ip6-localhost +
 *     localhost.localdomain subdomains / 0.1.0.1) ∥ cached
 *   residual preview nonstandard ports (3333/7777/16000/2345/1111/20000) ∥ cached
 *   residual schemes (ftp / file / sip / xmpp / mqtt / coap / rsync / tftp / news) ∥ cached
 *   case-mutated supported MIME (IMAGE/GIF, Image/Gif, AUDIO/MPEG, …) ∥ ok
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
// Residual SSRF (mid loopback / 10.128 / mapped / ff03 / fe80 / …) ∥ cached
// ---------------------------------------------------------------------------

describe('media ninth-wave concurrent residual SSRF ∥ cached after #371', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'loopback 127.128.0.1',
      url: 'http://127.128.0.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 10.128.255.1',
      url: 'http://10.128.255.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 192.168.128.255',
      url: 'http://192.168.128.255/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'rfc1918 172.18',
      url: 'http://172.18.255.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped dotted ::ffff:127.0.0.1',
      url: 'http://[::ffff:127.0.0.1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped hex ::ffff:c0a8:80ff',
      url: 'http://[::ffff:c0a8:80ff]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv4-mapped hex ::ffff:7f80:1',
      url: 'http://[::ffff:7f80:1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 multicast ff03',
      url: 'http://[ff03::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 multicast ff08',
      url: 'http://[ff08::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local fe80',
      url: 'http://[fe80::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local fe91',
      url: 'http://[fe91::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local fea1',
      url: 'http://[fea1::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 link-local febf',
      url: 'http://[febf::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 site-local fec1',
      url: 'http://[fec1::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 site-local fee1',
      url: 'http://[fee1::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 ula fc01',
      url: 'http://[fc01::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ipv6 ula fd00',
      url: 'http://[fd00::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'docs prefix 2001:db8:ffff',
      url: 'http://[2001:db8:ffff::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'svc.kubernetes.default.svc.cluster.local subdomain',
      url: 'http://svc.kubernetes.default.svc.cluster.local/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'foo.metadata.google.internal subdomain',
      url: 'http://foo.metadata.google.internal/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'z.local mdns',
      url: 'http://z.local/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'a.internal TLD',
      url: 'http://a.internal/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'xyz.ip6-localhost subdomain',
      url: 'http://xyz.ip6-localhost/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'abc.localhost.localdomain subdomain',
      url: 'http://abc.localhost.localdomain/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'current-network 0.1.0.1',
      url: 'http://0.1.0.1/',
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://127.128.0.1/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://[ff03::1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://svc.kubernetes.default.svc.cluster.local/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://172.18.255.1/')}`,
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
// Residual preview nonstandard ports 3333/7777/16000/2345/1111/20000 ∥ cached
// ---------------------------------------------------------------------------

describe('media ninth-wave concurrent residual ports ∥ cached after #371', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'preview nonstandard 3333',
      url: 'https://example.org:3333/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 7777',
      url: 'https://example.org:7777/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 16000',
      url: 'https://example.org:16000/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 2345',
      url: 'https://example.org:2345/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 1111',
      url: 'https://example.org:1111/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'preview nonstandard 20000',
      url: 'https://example.org:20000/',
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:3333/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('https://example.org:7777/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:16000/')}`,
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
// Residual schemes (ftp/file/sip/xmpp/mqtt/coap/rsync/tftp/news) ∥ cached
// ---------------------------------------------------------------------------

describe('media ninth-wave concurrent residual schemes ∥ cached after #371', () => {
  const cases: Array<{ label: string; url: string }> = [
    { label: 'ftp', url: 'ftp://example.org/' },
    { label: 'file', url: 'file:///etc/hosts' },
    { label: 'sip', url: 'sip:alice@example.org' },
    { label: 'xmpp', url: 'xmpp:room@conference.example.org' },
    { label: 'mqtt', url: 'mqtt://example.org/' },
    { label: 'coap', url: 'coap://example.org/' },
    { label: 'rsync', url: 'rsync://example.org/' },
    { label: 'tftp', url: 'tftp://example.org/' },
    { label: 'news', url: 'news://example.org/' },
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('ftp://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('sip:alice@example.org')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('mqtt://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('coap://example.org/')}`,
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
// Case-mutated *supported* MIME soft (leftovers after #371 eighth) ∥ ok
// ---------------------------------------------------------------------------

describe('media ninth-wave concurrent case-mutated supported MIME soft ∥ ok after #371', () => {
  it('v3 IMAGE/GIF ∥ image/gif — case-sensitive whitelist pin', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('GIF8');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'IMAGE/GIF', 'Content-Length': '4' },
        body: bytesOf('bad!'),
      }, env),
      request('/_matrix/media/v3/upload?filename=ok.gif', {
        method: 'POST',
        headers: { 'Content-Type': 'image/gif', 'Content-Length': String(okBody.byteLength) },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: IMAGE/GIF',
    });
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
  });

  it('v1 Image/Gif ∥ v3 image/gif under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'Image/Gif', 'Content-Length': '2' },
        body: bytesOf('no'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/gif', 'Content-Length': '4' },
        body: bytesOf('GIF8'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: Image/Gif');
  });

  for (const softType of [
    'AUDIO/MPEG',
    'AUDIO/OGG',
    'AUDIO/WEBM',
    'VIDEO/WebM',
    'APPLICATION/OCTET-STREAM',
    'Application/Pdf',
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
// Multi-error ninth-wave soft isolation
// ---------------------------------------------------------------------------

describe('media ninth-wave concurrent multi-error soft isolation after #371', () => {
  it('mapped-loopback-SSRF + port + scheme + case-MIME ∥ oks', async () => {
    const { db, media } = seedLocalDownload('loc9');
    const cache = seedPreviewCache();
    const env = envFor({ db, media, cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::ffff:127.0.0.1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:3333/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('ftp://example.org/')}`,
        {},
        env
      ),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'IMAGE/GIF', 'Content-Length': '1' },
        body: bytesOf('z'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
        body: bytesOf('ok'),
      }, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc9`, {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: IMAGE/GIF');
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
    it(`ninth-wave multi soft isolation flood-${i}`, async () => {
      const cache = seedPreviewCache();
      const db = createMediaDb();
      const media = createMediaBucket();
      const env = envFor({ db, media, cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[fe80::1]/')}`,
          {},
          env
        ),
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'AUDIO/MPEG', 'Content-Length': '1' },
          body: bytesOf('x'),
        }, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('mqtt://example.org/')}`,
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
      expect(softBody(results, 403).body.error).toBe('Unsupported content type: AUDIO/MPEG');
    });
  }
});
