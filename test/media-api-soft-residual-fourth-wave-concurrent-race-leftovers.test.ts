/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #318 / tip past #318+#319 —
 * residual *media* soft→*concurrent-race* fourth-wave binds unsaturated by:
 *   #301 first wave (classic SSRF / port 22 / ftp+file / placeholder softs),
 *   #305 second wave (Media not found / body M_TOO_LARGE),
 *   #318 third wave (charset MIME / dual TOO_LARGE / ::1 .local .internal
 *        fc00 decimal-IP / Invalid URL decoys — never IPv4-mapped/link-local/
 *        docs-prefix/k8s+metadata hostnames/fd00, never residual blocked
 *        ports 3306/445/6379/27017, never data/javascript/ws/gopher schemes,
 *        never preview nonstandard 3000, never mixed-case MIME under soft
 *        residual files, never placeholder soft quad under residual waves).
 *
 * Gap table (why leftover after #318):
 *   residual SSRF (::ffff / 169.254 / fe80 / 2001:db8 / fd00 /
 *     kubernetes.default / metadata.google.internal) ∥ cached
 *   residual blocked ports (3306/445/6379/27017) ∥ cached
 *   residual schemes (data / javascript / ws / gopher) ∥ cached
 *   preview nonstandard port 3000 exact ∥ cached
 *   mixed-case MIME (TEXT/HTML, Image/PNG rejected base) ∥ upload ok
 *   placeholder soft residual quad (remote + other + overwrite + missing)
 *     ∥ empty fill — never under soft residual second/third files
 *   multi: mapped-SSRF + port + scheme + mixed MIME + placeholder softs ∥ oks
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
const OTHER = '@bob:example.com';
const REMOTE = 'remote.example.org';
const PREVIEW_OK_URL = 'https://example.org/page';
const PREVIEW_CACHE_KEY = `preview:${PREVIEW_OK_URL}`;
const PREVIEW_CACHED = { 'og:title': 'Cached Example', 'og:site_name': 'example.org' };

const MEDIA_NOT_FOUND = {
  errcode: 'M_NOT_FOUND',
  error: 'Media not found',
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
// Residual SSRF (mapped/link-local/docs/k8s) ∥ cached — never under #318
// ---------------------------------------------------------------------------

describe('media fourth-wave concurrent residual SSRF ∥ cached after #318', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'ipv4-mapped loopback',
      url: 'http://[::ffff:127.0.0.1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'link-local AWS metadata',
      url: 'http://169.254.169.254/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'fe80 link-local',
      url: 'http://[fe80::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'docs prefix 2001:db8',
      url: 'http://[2001:db8::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'ula fd00',
      url: 'http://[fd00::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'kubernetes.default',
      url: 'http://kubernetes.default/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'metadata.google.internal',
      url: 'http://metadata.google.internal/',
      error: 'Access to internal hostnames is not allowed',
    },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} ∥ cached — exact soft under Promise.all`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(c.url)}`, {}, env),
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::ffff:127.0.0.1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://169.254.169.254/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://kubernetes.default/')}`,
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
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Access to internal IP addresses is not allowed',
        'Access to internal IP addresses is not allowed',
        'Access to internal hostnames is not allowed',
      ].sort()
    );
    expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
  });
});

// ---------------------------------------------------------------------------
// Residual blocked ports + nonstandard preview port ∥ cached
// ---------------------------------------------------------------------------

describe('media fourth-wave concurrent residual ports ∥ cached after #318', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'mysql 3306',
      url: 'https://example.org:3306/',
      error: 'Access to port 3306 is not allowed',
    },
    {
      label: 'smb 445',
      url: 'https://example.org:445/',
      error: 'Access to port 445 is not allowed',
    },
    {
      label: 'redis 6379',
      url: 'https://example.org:6379/',
      error: 'Access to port 6379 is not allowed',
    },
    {
      label: 'mongo 27017',
      url: 'https://example.org:27017/',
      error: 'Access to port 27017 is not allowed',
    },
    {
      label: 'preview nonstandard 3000',
      url: 'https://example.org:3000/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} ∥ cached — exact soft under Promise.all`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(c.url)}`, {}, env),
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:3306/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('https://example.org:6379/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:3000/')}`,
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
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Access to port 3306 is not allowed',
        'Access to port 6379 is not allowed',
        'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Residual schemes beyond ftp/file ∥ cached
// ---------------------------------------------------------------------------

describe('media fourth-wave concurrent residual schemes ∥ cached after #318', () => {
  const cases: Array<{ label: string; url: string }> = [
    { label: 'data', url: 'data:text/html,hi' },
    { label: 'javascript', url: 'javascript:alert(1)' },
    { label: 'ws', url: 'ws://example.org/' },
    { label: 'gopher', url: 'gopher://example.org/' },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} scheme ∥ cached — Only HTTP/HTTPS pin`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const results = await Promise.all([
        request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(c.url)}`, {}, env),
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
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('data:text/plain,x')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('ws://example.org/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('gopher://example.org/')}`,
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
      results.filter((r) => r.status === 400).every(
        (r) => r.body.error === 'Only HTTP and HTTPS protocols are allowed'
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mixed-case MIME soft ∥ upload ok — sequential leftovers only before
// ---------------------------------------------------------------------------

describe('media fourth-wave concurrent mixed-case MIME soft ∥ ok after #318', () => {
  it('v3 TEXT/HTML ∥ image/png — case-sensitive whitelist pin', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('png');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'TEXT/HTML', 'Content-Length': '4' },
        body: bytesOf('bad'),
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
      error: 'Unsupported content type: TEXT/HTML',
    });
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
  });

  it('v1 Application/JavaScript ∥ v3 jpeg under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/JavaScript', 'Content-Length': '2' },
        body: bytesOf('no'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' },
        body: bytesOf('jpg'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body.error).toBe(
      'Unsupported content type: Application/JavaScript'
    );
  });

  for (const softType of ['TEXT/CSS', 'Image/GIF', 'VIDEO/MP4', 'Text/Html; charset=UTF-8']) {
    it(`mixed-case MIME '${softType.split(';')[0]}' flood ∥ ok`, async () => {
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
      expect(softBody(results, 403).body.error).toBe(
        `Unsupported content type: ${softType.split(';')[0].trim()}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Placeholder soft residual under residual soft files (wave 1 only before)
// ---------------------------------------------------------------------------

describe('media fourth-wave concurrent placeholder soft residual after #318', () => {
  it('remote + other + overwrite + missing ∥ empty fill under race', async () => {
    const emptyId = 'ph4-empty';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: emptyId, content_length: 0 }),
        seedRow({ media_id: 'ph4-other', user_id: OTHER, content_length: 0 }),
        seedRow({ media_id: 'ph4-filled', content_length: 8 }),
      ],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${REMOTE}/x`, {
        method: 'PUT',
        body: bytesOf('a'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph4-other`, {
        method: 'PUT',
        body: bytesOf('b'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph4-filled`, {
        method: 'PUT',
        body: bytesOf('c'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/missing-ph4`, {
        method: 'PUT',
        body: bytesOf('d'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytesOf('ok'),
      }, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 403)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(['Cannot upload to remote server', 'Not authorized to upload to this media'].sort());
    expect(softBody(results, 409).body).toEqual({
      errcode: 'M_CANNOT_OVERWRITE_MEDIA',
      error: 'Media already uploaded',
    });
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    expect(softBody(results, 200).body).toEqual({});
    expect(media.puts.length).toBe(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`placeholder soft residual flood-${i}`, async () => {
      const emptyId = `ph4-f-empty-${i}`;
      const db = createMediaDb({
        rows: [
          seedRow({ media_id: emptyId, content_length: 0 }),
          seedRow({ media_id: `ph4-f-filled-${i}`, content_length: 3 }),
          seedRow({ media_id: `ph4-f-other-${i}`, user_id: OTHER, content_length: 0 }),
        ],
      });
      const media = createMediaBucket();
      const env = envFor({ db, media });
      const soft =
        i % 3 === 0
          ? request(`/_matrix/client/v1/media/upload/${REMOTE}/r-${i}`, {
              method: 'PUT',
              body: bytesOf('a'),
            }, env)
          : i % 3 === 1
            ? request(`/_matrix/client/v1/media/upload/${SERVER}/ph4-f-other-${i}`, {
                method: 'PUT',
                body: bytesOf('b'),
              }, env)
            : request(`/_matrix/client/v1/media/upload/${SERVER}/ph4-f-filled-${i}`, {
                method: 'PUT',
                body: bytesOf('c'),
              }, env);
      const results = await Promise.all([
        soft,
        request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
          method: 'PUT',
          body: bytesOf('ok'),
        }, env),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.some((r) => r.status === 200 && Object.keys(r.body).length === 0)).toBe(true);
      expect(results.some((r) => [403, 409].includes(r.status))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-error fourth-wave soft isolation
// ---------------------------------------------------------------------------

describe('media fourth-wave concurrent multi-error soft isolation after #318', () => {
  it('mapped-SSRF + port + scheme + mixed MIME + placeholder soft ∥ oks', async () => {
    const { db, media } = seedLocalDownload('loc4');
    const emptyId = 'ph4-mx-empty';
    db.rows.push(seedRow({ media_id: emptyId, content_length: 0 }));
    db.rows.push(seedRow({ media_id: 'ph4-mx-other', user_id: OTHER, content_length: 0 }));
    const cache = seedPreviewCache();
    const env = envFor({ db, media, cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::ffff:127.0.0.1]/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://example.org:6379/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('data:text/html,x')}`,
        {},
        env
      ),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'TEXT/HTML', 'Content-Length': '1' },
        body: bytesOf('z'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph4-mx-other`, {
        method: 'PUT',
        body: bytesOf('no'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
        body: bytesOf('ok'),
      }, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc4`, {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        body: bytesOf('fill'),
      }, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(softBody(results, 403).body.error).toMatch(/Unsupported content type: TEXT\/HTML|Not authorized/);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Access to internal IP addresses is not allowed',
        'Access to port 6379 is not allowed',
        'Only HTTP and HTTPS protocols are allowed',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`fourth-wave multi soft isolation flood-${i}`, async () => {
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
          headers: { 'Content-Type': 'TEXT/CSS', 'Content-Length': '1' },
          body: bytesOf('x'),
        }, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent('ws://example.org/')}`,
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
      expect(softBody(results, 403).body.error).toBe('Unsupported content type: TEXT/CSS');
    });
  }
});
