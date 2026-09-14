/**
 * TOKENMAXX HEAVY leftovers after tip past #294/#295 (and merged #296–#298) —
 * media *first concurrent soft-fail∥success* wave under Promise.all.
 *
 * Sequential soft floods live in media-api-routes / media-api-route-leftovers /
 * keys-media SSRF status-only floods. keys-media concurrent only races
 * placeholder double-fill TOCTOU success paths — never exact soft error:
 * strings under Promise.all (grep Unsupported content type / File exceeds /
 * Remote media not supported / Missing required parameter: url / Access to
 * internal / Only HTTP and HTTPS / Only standard HTTP ports / Invalid URL /
 * Cannot upload to remote / Not authorized / Media already uploaded in
 * *media*concurrent* = 0 aside from this file).
 *
 * Primary deepen:
 *   v3/v1 upload `Unsupported content type` + M_FORBIDDEN ∥ image upload ok;
 *   `File exceeds maximum upload size` + M_TOO_LARGE (Content-Length) ∥ ok;
 *   download/thumbnail `Remote media not supported` ∥ local 200;
 *   preview_url `Missing required parameter: url` + M_MISSING_PARAM ∥ cached;
 *   SSRF exact errors (internal IP/hostname, schemes, ports, Invalid URL) ∥
 *   cached preview success; placeholder PUT `Cannot upload to remote server` /
 *   `Not authorized` / `Media already uploaded` + M_CANNOT_OVERWRITE_MEDIA ∥
 *   own empty placeholder fill ok. Dual-path v3 + client/v1 where handlers
 *   duplicate.
 *
 * Avoided saturated open/merged siblings: room-cache, crypto/db, filters,
 * devices, admin/federation, oauth/oidc.
 * New file. Tests-only. example.com fixtures only. Reversible by delete.
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
type KvBarrier = { match: (key: string) => boolean; count: number };

type CacheKv = {
  data: Record<string, string>;
  puts: KvPut[];
  gets: string[];
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

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

async function withBarrier(
  barrier: { match: (...a: never[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...args: never[]
) {
  if (!barrier || !(barrier.match as (...a: unknown[]) => boolean)(...args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function createMediaDb(
  opts: {
    rows?: MediaRow[];
    firstBarrier?: SqlBarrier;
  } = {}
): MediaDb {
  const rows = opts.rows ? [...opts.rows] : [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  let firstBarrier = opts.firstBarrier;
  const firstWaiters = { list: [] as Array<() => void> };

  return {
    rows,
    inserts,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              await withBarrier(
                firstBarrier as never,
                firstWaiters,
                () => {
                  firstBarrier = undefined;
                },
                sql as never,
                args as never
              );

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

function createCache(
  data: Record<string, string> = {},
  opts: { getBarrier?: KvBarrier } = {}
): CacheKv {
  const puts: KvPut[] = [];
  const gets: string[] = [];
  let getBarrier = opts.getBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  const store = { ...data };

  return {
    data: store,
    puts,
    gets,
    async get(key: string) {
      await withBarrier(
        getBarrier as never,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key as never
      );
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
// Upload MIME soft ∥ success
// ---------------------------------------------------------------------------

describe('media concurrent Unsupported content type ∥ upload ok after tip #294/#295', () => {
  it('v3 text/html ∥ image/png — binds Unsupported content type + M_FORBIDDEN; sibling content_uri', async () => {
    const env = envFor();
    const okBody = bytesOf('okpng');
    const results = await Promise.all([
      request(
        '/_matrix/media/v3/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/html', 'Content-Length': '2' },
          body: bytesOf('<>'),
        },
        env
      ),
      request(
        '/_matrix/media/v3/upload?filename=ok.png',
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(okBody.byteLength) },
          body: okBody,
        },
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    const bad = softBody(results, 403);
    const ok = softBody(results, 200);
    expect(bad.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: text/html',
    });
    expect(ok.body.content_uri).toMatch(/^mxc:\/\/example\.com\//);
    expect(env._media.puts.length).toBe(1);
  });

  it('v1 application/javascript ∥ image/jpeg under race', async () => {
    const env = envFor();
    const okBody = bytesOf('jpeg');
    const results = await Promise.all([
      request(
        '/_matrix/client/v1/media/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/javascript', 'Content-Length': '3' },
          body: bytesOf('bad'),
        },
        env
      ),
      request(
        '/_matrix/client/v1/media/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(okBody.byteLength) },
          body: okBody,
        },
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: application/javascript',
    });
    expect(softBody(results, 200).body.content_uri).toContain('mxc://example.com/');
  });

  for (let i = 0; i < 8; i++) {
    it(`Unsupported MIME flood-${i} v3 ∥ v1 ok`, async () => {
      const env = envFor();
      const softType = i % 2 === 0 ? 'text/css' : 'application/x-msdownload';
      const softPath = i % 2 === 0 ? '/_matrix/media/v3/upload' : '/_matrix/client/v1/media/upload';
      const okPath = i % 2 === 0 ? '/_matrix/client/v1/media/upload' : '/_matrix/media/v3/upload';
      const okBody = bytesOf(`ok-${i}`);
      const results = await Promise.all([
        request(
          softPath,
          {
            method: 'POST',
            headers: { 'Content-Type': softType, 'Content-Length': '1' },
            body: bytesOf('x'),
          },
          env
        ),
        request(
          okPath,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'image/webp',
              'Content-Length': String(okBody.byteLength),
            },
            body: okBody,
          },
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body.error).toBe(`Unsupported content type: ${softType}`);
      expect(softBody(results, 403).body.errcode).toBe('M_FORBIDDEN');
    });
  }
});

// ---------------------------------------------------------------------------
// Upload size soft ∥ success
// ---------------------------------------------------------------------------

describe('media concurrent File exceeds maximum upload size ∥ ok after tip', () => {
  it('v3 Content-Length oversize ∥ small upload — M_TOO_LARGE exact error', async () => {
    const env = envFor();
    const okBody = bytesOf('tiny');
    const results = await Promise.all([
      request(
        '/_matrix/media/v3/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(MAX_UPLOAD_SIZE + 1),
          },
          body: bytesOf('x'),
        },
        env
      ),
      request(
        '/_matrix/media/v3/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(okBody.byteLength),
          },
          body: okBody,
        },
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 413]);
    expect(softBody(results, 413).body).toMatchObject({
      errcode: 'M_TOO_LARGE',
      error: 'File exceeds maximum upload size',
    });
    expect(env._media.puts.length).toBe(1);
  });

  it('v1 Content-Length oversize ∥ v3 ok under race', async () => {
    const env = envFor();
    const okBody = bytesOf('ok');
    const results = await Promise.all([
      request(
        '/_matrix/client/v1/media/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(MAX_UPLOAD_SIZE + 99),
          },
          body: bytesOf('x'),
        },
        env
      ),
      request(
        '/_matrix/media/v3/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(okBody.byteLength),
          },
          body: okBody,
        },
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 413]);
    expect(softBody(results, 413).body.error).toBe('File exceeds maximum upload size');
  });

  for (let i = 0; i < 6; i++) {
    it(`M_TOO_LARGE Content-Length flood-${i}`, async () => {
      const env = envFor();
      const path = i % 2 === 0 ? '/_matrix/media/v3/upload' : '/_matrix/client/v1/media/upload';
      const okBody = bytesOf(`ok${i}`);
      const results = await Promise.all([
        request(
          path,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(MAX_UPLOAD_SIZE + 1 + i),
            },
            body: bytesOf('x'),
          },
          env
        ),
        request(
          path,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(okBody.byteLength),
            },
            body: okBody,
          },
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 413]);
      expect(softBody(results, 413).body.errcode).toBe('M_TOO_LARGE');
    });
  }
});

// ---------------------------------------------------------------------------
// Remote media soft ∥ local download/thumbnail
// ---------------------------------------------------------------------------

describe('media concurrent Remote media not supported ∥ local after tip', () => {
  it('v3 download remote ∥ local — exact Remote media not supported', async () => {
    const { db, media } = seedLocalDownload('loc-dl-1');
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/media/v3/download/${REMOTE}/whatever`, {}, env),
      request(`/_matrix/media/v3/download/${SERVER}/loc-dl-1`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'Remote media not supported',
    });
    expect(softBody(results, 200).text).toBe('PNGDATA');
  });

  it('v3 thumbnail remote ∥ local fallback original', async () => {
    const { db, media } = seedLocalDownload('loc-th-1');
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/media/v3/thumbnail/${REMOTE}/x?width=32&height=32`, {}, env),
      request(`/_matrix/media/v3/thumbnail/${SERVER}/loc-th-1?width=32&height=32`, {}, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 404]);
    expect(softBody(results, 404).body.error).toBe('Remote media not supported');
  });

  it('v1 download + filename remote ∥ local under race', async () => {
    const { db, media } = seedLocalDownload('loc-dl-v1', 'BODY');
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/download/${REMOTE}/x/file.png`, {}, env),
      request(`/_matrix/client/v1/media/download/${SERVER}/loc-dl-v1/file.png`, {}, env),
      request(`/_matrix/client/v1/media/download/${REMOTE}/y`, {}, env),
    ]);
    const softs = results.filter((r) => r.status === 404);
    const ok = results.find((r) => r.status === 200)!;
    expect(softs).toHaveLength(2);
    expect(softs.every((r) => r.body.error === 'Remote media not supported')).toBe(true);
    expect(ok.text).toBe('BODY');
  });

  for (let i = 0; i < 6; i++) {
    it(`Remote media not supported flood-${i}`, async () => {
      const id = `loc-flood-${i}`;
      const { db, media } = seedLocalDownload(id, `D${i}`);
      const env = envFor({ db, media });
      const softPath =
        i % 3 === 0
          ? `/_matrix/media/v3/download/${REMOTE}/r${i}`
          : i % 3 === 1
            ? `/_matrix/client/v1/media/thumbnail/${REMOTE}/r${i}?width=8&height=8`
            : `/_matrix/media/v3/download/${REMOTE}/r${i}/name.png`;
      const okPath =
        i % 2 === 0
          ? `/_matrix/media/v3/download/${SERVER}/${id}`
          : `/_matrix/client/v1/media/download/${SERVER}/${id}`;
      const results = await Promise.all([
        request(softPath, {}, env),
        request(okPath, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 404]);
      expect(softBody(results, 404).body.error).toBe('Remote media not supported');
    });
  }
});

// ---------------------------------------------------------------------------
// preview_url missing param ∥ cached success
// ---------------------------------------------------------------------------

describe('media concurrent Missing required parameter: url ∥ cached preview after tip', () => {
  it('v3 missing url ∥ cached preview — M_MISSING_PARAM exact', async () => {
    const cache = seedPreviewCache();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor({ cache });
    const results = await Promise.all([
      request('/_matrix/media/v3/preview_url', {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: url',
    });
    expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v1 missing url ∥ v3 cached under race', async () => {
    const cache = seedPreviewCache();
    vi.stubGlobal('fetch', vi.fn());
    const env = envFor({ cache });
    const results = await Promise.all([
      request('/_matrix/client/v1/media/preview_url', {}, env),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body.error).toBe('Missing required parameter: url');
    expect(softBody(results, 200).body['og:title']).toBe('Cached Example');
  });

  for (let i = 0; i < 6; i++) {
    it(`Missing url ∥ cached flood-${i}`, async () => {
      const cache = seedPreviewCache();
      vi.stubGlobal('fetch', vi.fn());
      const env = envFor({ cache });
      const soft =
        i % 2 === 0
          ? '/_matrix/media/v3/preview_url'
          : '/_matrix/client/v1/media/preview_url';
      const ok =
        i % 2 === 0
          ? `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`
          : `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`;
      const results = await Promise.all([request(soft, {}, env), request(ok, {}, env)]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.errcode).toBe('M_MISSING_PARAM');
    });
  }
});

// ---------------------------------------------------------------------------
// preview_url SSRF exact errors ∥ cached success
// ---------------------------------------------------------------------------

describe('media concurrent preview SSRF exact errors ∥ cached success after tip', () => {
  const cases: Array<{ label: string; url: string; error: string }> = [
    {
      label: 'internal IP',
      url: 'http://127.0.0.1/secret',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'private RFC1918',
      url: 'http://192.168.1.1/',
      error: 'Access to internal IP addresses is not allowed',
    },
    {
      label: 'localhost hostname',
      url: 'https://localhost/x',
      error: 'Access to internal hostnames is not allowed',
    },
    {
      label: 'ftp scheme',
      url: 'ftp://example.org/x',
      error: 'Only HTTP and HTTPS protocols are allowed',
    },
    {
      label: 'file scheme',
      url: 'file:///etc/passwd',
      error: 'Only HTTP and HTTPS protocols are allowed',
    },
    {
      label: 'blocked SSH port',
      url: 'https://example.org:22/',
      error: 'Access to port 22 is not allowed',
    },
    {
      label: 'nonstandard preview port',
      url: 'https://example.org:9999/',
      error: 'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview',
    },
    {
      label: 'invalid URL',
      url: 'not a url',
      error: 'Invalid URL format',
    },
  ];

  for (const c of cases) {
    it(`v3 ${c.label} ∥ cached — binds exact error under Promise.all`, async () => {
      const cache = seedPreviewCache();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
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
      const bad = softBody(results, 400);
      expect(bad.body).toEqual({ errcode: 'M_UNKNOWN', error: c.error });
      expect(softBody(results, 200).body).toEqual(PREVIEW_CACHED);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`v1 ${c.label} ∥ cached under race`, async () => {
      const cache = seedPreviewCache();
      vi.stubGlobal('fetch', vi.fn());
      const env = envFor({ cache });
      const results = await Promise.all([
        request(
          `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(c.url)}`,
          {},
          env
        ),
        request(
          `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.error).toBe(c.error);
    });
  }

  it('multi SSRF softs ∥ one cached success under race', async () => {
    const cache = seedPreviewCache();
    vi.stubGlobal('fetch', vi.fn());
    const env = envFor({ cache });
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://10.0.0.1/')}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('https://metadata/')}`,
        {},
        env
      ),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('ftp://x')}`,
        {},
        env
      ),
    ]);
    const softs = results.filter((r) => r.status === 400);
    const oks = results.filter((r) => r.status === 200);
    expect(softs).toHaveLength(3);
    expect(oks).toHaveLength(1);
    expect(softs.map((r) => r.body.error).sort()).toEqual(
      [
        'Access to internal IP addresses is not allowed',
        'Access to internal hostnames is not allowed',
        'Only HTTP and HTTPS protocols are allowed',
      ].sort()
    );
    expect(oks[0].body).toEqual(PREVIEW_CACHED);
  });
});

// ---------------------------------------------------------------------------
// Placeholder PUT softs ∥ own empty fill
// ---------------------------------------------------------------------------

describe('media concurrent placeholder softs ∥ own fill after tip', () => {
  it('Cannot upload to remote server ∥ local empty fill', async () => {
    const mediaId = 'ph-ok-1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${REMOTE}/ph-remote`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytesOf('x'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytesOf('ok'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot upload to remote server',
    });
    expect(softBody(results, 200).body).toEqual({});
    expect(media.puts.length).toBe(1);
    expect(db.rows.find((r) => r.media_id === mediaId)?.content_length).toBe(2);
  });

  it('Not authorized to upload to this media ∥ own empty fill', async () => {
    const ownId = 'ph-own';
    const otherId = 'ph-other';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: ownId, content_length: 0 }),
        seedRow({ media_id: otherId, user_id: OTHER, content_length: 0 }),
      ],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${SERVER}/${otherId}`, {
        method: 'PUT',
        body: bytesOf('nope'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${ownId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/gif' },
        body: bytesOf('gif'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not authorized to upload to this media',
    });
    expect(softBody(results, 200).body).toEqual({});
  });

  it('Media already uploaded + M_CANNOT_OVERWRITE_MEDIA ∥ empty fill', async () => {
    const emptyId = 'ph-empty';
    const filledId = 'ph-filled';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: emptyId, content_length: 0 }),
        seedRow({ media_id: filledId, content_length: 10 }),
      ],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${SERVER}/${filledId}`, {
        method: 'PUT',
        body: bytesOf('no'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        body: bytesOf('yes'),
      }, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 409]);
    expect(softBody(results, 409).body).toEqual({
      errcode: 'M_CANNOT_OVERWRITE_MEDIA',
      error: 'Media already uploaded',
    });
    expect(softBody(results, 200).body).toEqual({});
    expect(media.puts.length).toBe(1);
  });

  it('triple soft (remote + other + filled) ∥ one empty fill under race', async () => {
    const emptyId = 'ph-tri-empty';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: emptyId, content_length: 0 }),
        seedRow({ media_id: 'ph-tri-other', user_id: OTHER, content_length: 0 }),
        seedRow({ media_id: 'ph-tri-filled', content_length: 5 }),
      ],
    });
    const media = createMediaBucket();
    const env = envFor({ db, media });
    const results = await Promise.all([
      request(`/_matrix/client/v1/media/upload/${REMOTE}/x`, {
        method: 'PUT',
        body: bytesOf('a'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph-tri-other`, {
        method: 'PUT',
        body: bytesOf('b'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/ph-tri-filled`, {
        method: 'PUT',
        body: bytesOf('c'),
      }, env),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        body: bytesOf('ok'),
      }, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 403)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(['Cannot upload to remote server', 'Not authorized to upload to this media'].sort());
    expect(softBody(results, 409).body.error).toBe('Media already uploaded');
  });

  for (let i = 0; i < 8; i++) {
    it(`placeholder soft flood-${i}`, async () => {
      const emptyId = `ph-f-empty-${i}`;
      const db = createMediaDb({
        rows: [
          seedRow({ media_id: emptyId, content_length: 0 }),
          seedRow({ media_id: `ph-f-filled-${i}`, content_length: 3 }),
          seedRow({ media_id: `ph-f-other-${i}`, user_id: OTHER, content_length: 0 }),
        ],
      });
      const media = createMediaBucket();
      const env = envFor({ db, media });
      const soft =
        i % 3 === 0
          ? request(`/_matrix/client/v1/media/upload/${REMOTE}/r${i}`, {
              method: 'PUT',
              body: bytesOf('x'),
            }, env)
          : i % 3 === 1
            ? request(`/_matrix/client/v1/media/upload/${SERVER}/ph-f-other-${i}`, {
                method: 'PUT',
                body: bytesOf('x'),
              }, env)
            : request(`/_matrix/client/v1/media/upload/${SERVER}/ph-f-filled-${i}`, {
                method: 'PUT',
                body: bytesOf('x'),
              }, env);
      const results = await Promise.all([
        soft,
        request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
          method: 'PUT',
          body: bytesOf(`ok${i}`),
        }, env),
      ]);
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(results.some((r) => [403, 409].includes(r.status))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-route soft isolation under shared env
// ---------------------------------------------------------------------------

describe('media concurrent cross-route soft isolation after tip', () => {
  it('MIME soft + remote download soft + missing preview url ∥ upload+download+cached', async () => {
    const { db, media } = seedLocalDownload('cross-loc');
    const cache = seedPreviewCache();
    vi.stubGlobal('fetch', vi.fn());
    const env = envFor({ db, media, cache });
    const okBody = bytesOf('png');
    const results = await Promise.all([
      request(
        '/_matrix/media/v3/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/html', 'Content-Length': '1' },
          body: bytesOf('x'),
        },
        env
      ),
      request(`/_matrix/media/v3/download/${REMOTE}/nope`, {}, env),
      request('/_matrix/media/v3/preview_url', {}, env),
      request(
        '/_matrix/media/v3/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(okBody.byteLength) },
          body: okBody,
        },
        env
      ),
      request(`/_matrix/media/v3/download/${SERVER}/cross-loc`, {}, env),
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    expect(softBody(results, 403).body.error).toBe('Unsupported content type: text/html');
    expect(softBody(results, 404).body.error).toBe('Remote media not supported');
    expect(softBody(results, 400).body.error).toBe('Missing required parameter: url');
  });

  it('SSRF + M_TOO_LARGE + overwrite ∥ cached preview + small upload + empty fill', async () => {
    const emptyId = 'cross-ph';
    const db = createMediaDb({
      rows: [
        seedRow({ media_id: emptyId, content_length: 0 }),
        seedRow({ media_id: 'cross-filled', content_length: 9 }),
      ],
    });
    const media = createMediaBucket();
    const cache = seedPreviewCache();
    vi.stubGlobal('fetch', vi.fn());
    const env = envFor({ db, media, cache });
    const okBody = bytesOf('ok');
    const results = await Promise.all([
      request(
        `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://127.0.0.1/')}`,
        {},
        env
      ),
      request(
        '/_matrix/client/v1/media/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(MAX_UPLOAD_SIZE + 1),
          },
          body: bytesOf('x'),
        },
        env
      ),
      request(`/_matrix/client/v1/media/upload/${SERVER}/cross-filled`, {
        method: 'PUT',
        body: bytesOf('no'),
      }, env),
      request(
        `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
        {},
        env
      ),
      request(
        '/_matrix/client/v1/media/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(okBody.byteLength),
          },
          body: okBody,
        },
        env
      ),
      request(`/_matrix/client/v1/media/upload/${SERVER}/${emptyId}`, {
        method: 'PUT',
        body: bytesOf('yes'),
      }, env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(softBody(results, 400).body.error).toBe(
      'Access to internal IP addresses is not allowed'
    );
    expect(softBody(results, 413).body.error).toBe('File exceeds maximum upload size');
    expect(softBody(results, 409).body.error).toBe('Media already uploaded');
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-route soft isolation flood-${i}`, async () => {
      const { db, media } = seedLocalDownload(`xf-${i}`);
      const cache = seedPreviewCache();
      vi.stubGlobal('fetch', vi.fn());
      const env = envFor({ db, media, cache });
      const results = await Promise.all([
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(
            i % 2 === 0 ? 'https://localhost/' : 'ftp://example.org/'
          )}`,
          {},
          env
        ),
        request(`/_matrix/media/v3/download/${REMOTE}/x${i}`, {}, env),
        request(
          `/_matrix/media/v3/preview_url?url=${encodeURIComponent(PREVIEW_OK_URL)}`,
          {},
          env
        ),
        request(`/_matrix/media/v3/download/${SERVER}/xf-${i}`, {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 400, 404]);
      expect(softBody(results, 400).body.errcode).toBe('M_UNKNOWN');
      expect(softBody(results, 404).body.error).toBe('Remote media not supported');
    });
  }
});
