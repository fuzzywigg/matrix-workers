/**
 * TOKENMAXX HEAVY tip-relaunch after closed #316 / tip past #305+#310+#313 —
 * residual *media* soft→*concurrent-race* third-wave binds unsaturated by:
 *   #301 first wave (bare MIME / header M_TOO_LARGE / classic SSRF set),
 *   #305 second wave (Media not found / body-byteLength M_TOO_LARGE /
 *        multi-error Media not found — never charset MIME under PA, never
 *        dual header∥body M_TOO_LARGE, never residual SSRF ::1/.local/
 *        .internal/fc00/decimal-IP, never whitespace/decoy Invalid URL ∥
 *        cached under soft concurrent files).
 *
 * Gap table (why leftover after #305):
 *   Unsupported content type with charset params ∥ upload ok
 *     | #301 bare MIME only; sequential charset in media-api-routes
 *   leading-semicolon empty base MIME ∥ ok
 *     | sequential only in media-api-routes
 *   dual M_TOO_LARGE header ∥ body-byteLength ∥ small ok
 *     | waves 1+2 tested each path alone
 *   residual SSRF (::1, .local, .internal, fc00, decimal IP) ∥ cached
 *     | #301 classic SSRF only
 *   whitespace / decoy url → Invalid URL format ∥ cached (+ vs Missing param)
 *     | #301 missing-param / bare "not a url" only; never decoy matrix under PA
 *   multi: charset MIME + dual TOO_LARGE + residual SSRF + Media not found
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
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const PREVIEW_OK_URL = 'https://example.org/page';
const PREVIEW_CACHE_KEY = `preview:${PREVIEW_OK_URL}`;
const PREVIEW_CACHED = { 'og:title': 'Cached Example', 'og:site_name': 'example.org' };

const MEDIA_NOT_FOUND = {
  errcode: 'M_NOT_FOUND',
  error: 'Media not found',
} as const;

const FILE_EXCEEDS = {
  errcode: 'M_TOO_LARGE',
  error: 'File exceeds maximum upload size',
} as const;

const MISSING_URL = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: url',
} as const;

const INVALID_URL = {
  errcode: 'M_UNKNOWN',
  error: 'Invalid URL format',
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
// Charset MIME soft ∥ upload ok — never under #301/#305 soft concurrent
// ---------------------------------------------------------------------------

describe('media third-wave concurrent charset MIME soft ∥ ok after #305', () => {
  it('v3 text/html; charset=utf-8 ∥ image/png — base MIME pin', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('png');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '1' },
        body: bytesOf('x'),
      }, env),
      request('/_matrix/media/v3/upload?filename=ok.png', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: text/html',
    });
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
  });

  it('v1 application/javascript;charset=UTF-8 ∥ v3 jpeg under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('jpg');
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/javascript;charset=UTF-8',
          'Content-Length': '1',
        },
        body: bytesOf('x'),
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
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body.error).toBe(
      'Unsupported content type: application/javascript'
    );
  });

  it('leading-semicolon empty base MIME ∥ png ok under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const okBody = bytesOf('ok');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': ';charset=utf-8', 'Content-Length': '1' },
        body: bytesOf('x'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: ',
    });
  });

  for (const softType of [
    'text/css; charset=utf-8',
    'application/xml;charset=utf-8',
    'application/x-msdownload; charset=binary',
    'text/javascript; charset="utf-8"',
  ]) {
    it(`charset MIME '${softType.split(';')[0]}' flood ∥ ok`, async () => {
      const db = createMediaDb();
      const media = createMediaBucket();
      const env = envFor({ db, media });
      const okBody = bytesOf('z');
      const results = await Promise.all([
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: { 'Content-Type': softType, 'Content-Length': '1' },
          body: bytesOf('x'),
        }, env),
        request('/_matrix/client/v1/media/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(okBody.byteLength),
          },
          body: okBody,
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
// Dual M_TOO_LARGE header ∥ body-byteLength ∥ small ok
// ---------------------------------------------------------------------------

describe('media third-wave concurrent dual M_TOO_LARGE paths after #305', () => {
  it('header Content-Length oversize ∥ body oversize ∥ small upload', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const bodyOversize = new ArrayBuffer(MAX_UPLOAD_SIZE + 3);
    const okBody = bytesOf('tiny');
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MAX_UPLOAD_SIZE + 1),
        },
        body: bytesOf('hdr'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '2',
        },
        body: bodyOversize,
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
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 413)).toHaveLength(2);
    expect(
      results.filter((r) => r.status === 413).every((r) => r.body.error === FILE_EXCEEDS.error)
    ).toBe(true);
    expect(media.puts).toHaveLength(1);
  });

  it('v1 header oversize ∥ v3 body oversize ∥ v1 ok under race', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const bodyOversize = new ArrayBuffer(MAX_UPLOAD_SIZE + 8);
    const okBody = bytesOf('ok');
    const results = await Promise.all([
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MAX_UPLOAD_SIZE + 9),
        },
        body: bytesOf('h'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1',
        },
        body: bodyOversize,
      }, env),
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 413, 413]);
    expect(softBody(results, 200).body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
    expect(
      results.filter((r) => r.status === 413).every((r) => r.body.error === FILE_EXCEEDS.error)
    ).toBe(true);
  });

  for (let i = 0; i < 4; i++) {
    it(`dual M_TOO_LARGE flood-${i}`, async () => {
      const db = createMediaDb();
      const media = createMediaBucket();
      const env = envFor({ db, media });
      const okBody = bytesOf(`o${i}`);
      const results = await Promise.all([
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(MAX_UPLOAD_SIZE + 10 + i),
          },
          body: bytesOf('x'),
        }, env),
        request('/_matrix/client/v1/media/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '1',
          },
          body: new ArrayBuffer(MAX_UPLOAD_SIZE + 1 + i),
        }, env),
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(okBody.byteLength),
          },
          body: okBody,
        }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 413, 413]);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual SSRF (::1 / .local / .internal / fc00 / decimal) ∥ cached
// ---------------------------------------------------------------------------

describe('media third-wave concurrent residual SSRF ∥ cached after #305', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'ipv6 loopback',
      url: 'http://[::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'mdns .local',
      url: 'http://printer.local/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: '.internal TLD',
      url: 'http://svc.internal/',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'ula fc00',
      url: 'http://[fc00::1]/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'decimal IPv4 (URL-normalized)',
      url: 'http://2130706433/',
      error: 'Access to internal IP addresses is not allowed',
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
    });
  }

  it('multi residual SSRF softs ∥ one cached under race', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::1]/')}`, {}, env),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://x.local/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[fc00::2]/')}`,
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
    expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
  });
});

// ---------------------------------------------------------------------------
// Whitespace / decoy url → Invalid URL format ∥ cached (+ vs Missing param)
// ---------------------------------------------------------------------------

describe('media third-wave concurrent Invalid URL soft ∥ cached after #305', () => {
  it('v3 whitespace url Invalid URL format ∥ cached success', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(' ')}`, {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toEqual(INVALID_URL);
    expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
  });

  it('Invalid URL ∥ Missing url ∥ cached — distinct softs under race', async () => {
    const cache = seedPreviewCache();
    const env = envFor({ cache });
    const results = await Promise.all([
      request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent('null')}`, {}, env),
      request('/_matrix/media/v3/preview_url', {}, env),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400, 400]);
    const softs = results
      .filter((r) => r.status === 400)
      .map((r) => r.body)
      .sort((a, b) => String(a.error).localeCompare(String(b.error)));
    expect(softs).toEqual(
      [INVALID_URL, MISSING_URL].sort((a, b) => a.error.localeCompare(b.error))
    );
  });

  for (const [i, decoy] of [' ', 'undefined', 'http://', ':///'].entries()) {
    it(`Invalid URL decoy flood-${i} ∥ cached`, async () => {
      const cache = seedPreviewCache();
      const env = envFor({ cache });
      const softPath =
        i % 2 === 0
          ? `/_matrix/media/v3/preview_url?url=${encodeURIComponent(decoy)}`
          : `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(decoy)}`;
      const results = await Promise.all([
        request(softPath, {}, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual(INVALID_URL);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-error third-wave soft isolation
// ---------------------------------------------------------------------------

describe('media third-wave concurrent multi-error soft isolation after #305', () => {
  it('charset MIME + dual TOO_LARGE + residual SSRF + Media not found ∥ oks', async () => {
    const local = seedLocalDownload('loc-tw3', 'TW3');
    const cache = seedPreviewCache();
    const env = envFor({ ...local, cache });
    const okBody = bytesOf('png');
    const bodyOversize = new ArrayBuffer(MAX_UPLOAD_SIZE + 2);
    const results = await Promise.all([
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': '1',
        },
        body: bytesOf('x'),
      }, env),
      request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MAX_UPLOAD_SIZE + 1),
        },
        body: bytesOf('h'),
      }, env),
      request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1',
        },
        body: bodyOversize,
      }, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::1]/')}`,
        {},
        env
      ),
      request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(' ')}`, {}, env),
      request(`/_matrix/media/v3/download/${SERVER}/gone-tw3`, {}, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc-tw3`, {}, env),
      request('/_matrix/media/v3/upload?filename=ok.png', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(okBody.byteLength),
        },
        body: okBody,
      }, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(results.filter((r) => r.status === 413)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(results.filter((r) => r.status === 404)).toHaveLength(1);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: text/html');
    expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      ['Access to internal IP addresses is not allowed', 'Invalid URL format'].sort()
    );
  });

  for (let i = 0; i < 4; i++) {
    it(`third-wave multi soft isolation flood-${i}`, async () => {
      const id = `loc-tw3f-${i}`;
      const local = seedLocalDownload(id, `F${i}`);
      const cache = seedPreviewCache();
      const env = envFor({ ...local, cache });
      const results = await Promise.all([
        request('/_matrix/media/v3/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Content-Length': '1',
          },
          body: bytesOf('x'),
        }, env),
        request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent('null')}`, {}, env),
        request(`/_matrix/media/v3/download/${SERVER}/gone-tw3f-${i}`, {}, env),
        request(`/_matrix/media/v3/download/${SERVER}/${id}`, {}, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.status === 403)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(1);
      expect(results.filter((r) => r.status === 404)).toHaveLength(1);
      expect(softBody(results, 403).body.error).toBe('Unsupported content type: text/css');
      expect(softBody(results, 400).body).toEqual(INVALID_URL);
      expect(softBody(results, 404).body).toEqual(MEDIA_NOT_FOUND);
    });
  }
});

