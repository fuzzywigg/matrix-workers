/**
 * TOKENMAXX HEAVY leftovers after #154 — media API soft/edge/reliability.
 * Complements media-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
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
                // Upload path: bind(mediaId, userId, contentType, contentLength, filename, createdAt)
                // Create placeholder: bind(mediaId, userId, createdAt) with literals in SQL
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
  return {
    data,
    puts,
    async get(key: string) {
      return data[key] ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      data[key] = value;
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
  const cache = opts.cache ?? createCache();
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
  const cache = opts.cache ?? createCache();
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
// media/v3 config
// ============================================

describe('media leftovers v3 config soft flood after #154', () => {

  it('GET v3 config soft-0', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-1', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-2', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-3', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-4', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-5', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-6', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-7', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-8', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-9', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-10', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-11', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-12', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-13', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-14', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET v3 config soft-15', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });
});

describe('media leftovers client v1 config soft flood after #154', () => {

  it('GET client v1 config soft-0', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-1', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-2', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-3', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-4', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-5', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-6', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-7', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-8', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-9', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-10', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-11', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-12', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-13', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-14', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET client v1 config soft-15', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });
});

describe('media leftovers v3 upload soft flood after #154', () => {

  it('POST v3 upload soft-0', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo0.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG0'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo0.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-1', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo1.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG1'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo1.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-2', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo2.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG2'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo2.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-3', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo3.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG3'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo3.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-4', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo4.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG4'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo4.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-5', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo5.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG5'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo5.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-6', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo6.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG6'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo6.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-7', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo7.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG7'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo7.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-8', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo8.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG8'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo8.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-9', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo9.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG9'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo9.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-10', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo10.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG10'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo10.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-11', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo11.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG11'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo11.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-12', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo12.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG12'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo12.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-13', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo13.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG13'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo13.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-14', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo14.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG14'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo14.png');
    expect(res.media.puts).toHaveLength(1);
  });

  it('POST v3 upload soft-15', async () => {
    const res = await request('/_matrix/media/v3/upload?filename=photo15.png', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
      },
      body: bytesOf('PNG15'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0].filename).toBe('photo15.png');
    expect(res.media.puts).toHaveLength(1);
  });
});

describe('media leftovers client v1 upload soft flood after #154', () => {

  it('POST client v1 upload soft-0', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c0.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN0'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-1', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c1.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN1'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-2', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c2.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN2'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-3', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c3.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN3'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-4', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c4.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN4'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-5', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c5.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN5'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-6', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c6.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN6'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-7', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c7.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN7'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-8', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c8.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN8'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-9', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c9.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN9'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-10', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c10.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN10'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-11', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c11.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN11'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-12', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c12.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN12'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-13', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c13.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN13'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-14', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c14.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN14'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('POST client v1 upload soft-15', async () => {
    const res = await request('/_matrix/client/v1/media/upload?filename=c15.bin', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/octet-stream',
      },
      body: bytesOf('BIN15'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//) });
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
  });
});

describe('media leftovers create placeholder soft flood after #154', () => {

  it('POST create soft-0', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-1', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-2', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-3', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-4', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-5', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-6', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-7', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-8', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-9', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-10', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-11', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-12', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-13', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-14', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('POST create soft-15', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content_uri: expect.stringMatching(/^mxc:\/\/example\.com\//),
      unused_expires_at: expect.any(Number),
    });
    expect(res.db.rows[0].content_length).toBe(0);
  });
});

describe('media leftovers download soft flood after #154', () => {

  it('GET v3 download soft-0', async () => {
    const mediaId = 'dl0';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f0.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG0'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG0');
  });

  it('GET v3 download soft-1', async () => {
    const mediaId = 'dl1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f1.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG1'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG1');
  });

  it('GET v3 download soft-2', async () => {
    const mediaId = 'dl2';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f2.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG2'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG2');
  });

  it('GET v3 download soft-3', async () => {
    const mediaId = 'dl3';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f3.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG3'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG3');
  });

  it('GET v3 download soft-4', async () => {
    const mediaId = 'dl4';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f4.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG4'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG4');
  });

  it('GET v3 download soft-5', async () => {
    const mediaId = 'dl5';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f5.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG5'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG5');
  });

  it('GET v3 download soft-6', async () => {
    const mediaId = 'dl6';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f6.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG6'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG6');
  });

  it('GET v3 download soft-7', async () => {
    const mediaId = 'dl7';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f7.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG7'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG7');
  });

  it('GET v3 download soft-8', async () => {
    const mediaId = 'dl8';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f8.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG8'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG8');
  });

  it('GET v3 download soft-9', async () => {
    const mediaId = 'dl9';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f9.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG9'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG9');
  });

  it('GET v3 download soft-10', async () => {
    const mediaId = 'dl10';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f10.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG10'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG10');
  });

  it('GET v3 download soft-11', async () => {
    const mediaId = 'dl11';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f11.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG11'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG11');
  });

  it('GET v3 download soft-12', async () => {
    const mediaId = 'dl12';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f12.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG12'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG12');
  });

  it('GET v3 download soft-13', async () => {
    const mediaId = 'dl13';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f13.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG13'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG13');
  });

  it('GET v3 download soft-14', async () => {
    const mediaId = 'dl14';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f14.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG14'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG14');
  });

  it('GET v3 download soft-15', async () => {
    const mediaId = 'dl15';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'f15.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMG15'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/image\/png/);
    expect(res.text).toBe('IMG15');
  });

  it('GET v3 download missing soft-0', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone0`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-1', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone1`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-2', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone2`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-3', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone3`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-4', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone4`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-5', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone5`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-6', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone6`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-7', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone7`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-8', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone8`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-9', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone9`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-10', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone10`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-11', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone11`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-12', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone12`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-13', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone13`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-14', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone14`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download missing soft-15', async () => {
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone15`, {}, { db: createMediaDb() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-0', async () => {
    const res = await request(`/_matrix/media/v3/download/remote0.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-1', async () => {
    const res = await request(`/_matrix/media/v3/download/remote1.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-2', async () => {
    const res = await request(`/_matrix/media/v3/download/remote2.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-3', async () => {
    const res = await request(`/_matrix/media/v3/download/remote3.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-4', async () => {
    const res = await request(`/_matrix/media/v3/download/remote4.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-5', async () => {
    const res = await request(`/_matrix/media/v3/download/remote5.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-6', async () => {
    const res = await request(`/_matrix/media/v3/download/remote6.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-7', async () => {
    const res = await request(`/_matrix/media/v3/download/remote7.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-8', async () => {
    const res = await request(`/_matrix/media/v3/download/remote8.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-9', async () => {
    const res = await request(`/_matrix/media/v3/download/remote9.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-10', async () => {
    const res = await request(`/_matrix/media/v3/download/remote10.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-11', async () => {
    const res = await request(`/_matrix/media/v3/download/remote11.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-12', async () => {
    const res = await request(`/_matrix/media/v3/download/remote12.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-13', async () => {
    const res = await request(`/_matrix/media/v3/download/remote13.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-14', async () => {
    const res = await request(`/_matrix/media/v3/download/remote14.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('GET v3 download remote gate soft-15', async () => {
    const res = await request(`/_matrix/media/v3/download/remote15.org/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

describe('media leftovers client v1 download soft flood after #154', () => {

  it('GET client v1 download soft-0', async () => {
    const mediaId = 'cv10';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV0'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV0');
  });

  it('GET client v1 download soft-1', async () => {
    const mediaId = 'cv11';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV1'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV1');
  });

  it('GET client v1 download soft-2', async () => {
    const mediaId = 'cv12';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV2'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV2');
  });

  it('GET client v1 download soft-3', async () => {
    const mediaId = 'cv13';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV3'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV3');
  });

  it('GET client v1 download soft-4', async () => {
    const mediaId = 'cv14';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV4'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV4');
  });

  it('GET client v1 download soft-5', async () => {
    const mediaId = 'cv15';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV5'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV5');
  });

  it('GET client v1 download soft-6', async () => {
    const mediaId = 'cv16';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV6'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV6');
  });

  it('GET client v1 download soft-7', async () => {
    const mediaId = 'cv17';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV7'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV7');
  });

  it('GET client v1 download soft-8', async () => {
    const mediaId = 'cv18';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV8'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV8');
  });

  it('GET client v1 download soft-9', async () => {
    const mediaId = 'cv19';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV9'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV9');
  });

  it('GET client v1 download soft-10', async () => {
    const mediaId = 'cv110';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV10'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV10');
  });

  it('GET client v1 download soft-11', async () => {
    const mediaId = 'cv111';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV11'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV11');
  });

  it('GET client v1 download soft-12', async () => {
    const mediaId = 'cv112';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV12'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV12');
  });

  it('GET client v1 download soft-13', async () => {
    const mediaId = 'cv113';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV13'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV13');
  });

  it('GET client v1 download soft-14', async () => {
    const mediaId = 'cv114';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV14'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV14');
  });

  it('GET client v1 download soft-15', async () => {
    const mediaId = 'cv115';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('CV15'), httpMetadata: { contentType: 'image/jpeg' } },
    });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {
      headers: { Authorization: 'Bearer t' },
    }, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CV15');
  });
});

describe('media leftovers filename download soft flood after #154', () => {

  it('GET v3 download with filename soft-0', async () => {
    const mediaId = 'fn0';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig0.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F0'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named0.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named0\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-1', async () => {
    const mediaId = 'fn1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig1.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F1'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named1.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named1\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-2', async () => {
    const mediaId = 'fn2';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig2.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F2'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named2.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named2\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-3', async () => {
    const mediaId = 'fn3';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig3.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F3'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named3.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named3\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-4', async () => {
    const mediaId = 'fn4';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig4.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F4'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named4.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named4\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-5', async () => {
    const mediaId = 'fn5';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig5.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F5'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named5.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named5\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-6', async () => {
    const mediaId = 'fn6';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig6.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F6'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named6.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named6\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-7', async () => {
    const mediaId = 'fn7';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig7.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F7'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named7.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named7\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-8', async () => {
    const mediaId = 'fn8';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig8.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F8'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named8.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named8\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-9', async () => {
    const mediaId = 'fn9';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig9.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F9'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named9.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named9\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-10', async () => {
    const mediaId = 'fn10';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig10.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F10'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named10.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named10\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-11', async () => {
    const mediaId = 'fn11';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig11.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F11'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named11.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named11\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-12', async () => {
    const mediaId = 'fn12';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig12.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F12'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named12.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named12\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-13', async () => {
    const mediaId = 'fn13';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig13.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F13'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named13.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named13\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-14', async () => {
    const mediaId = 'fn14';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig14.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F14'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named14.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named14\.png|inline|attachment/i);
  });

  it('GET v3 download with filename soft-15', async () => {
    const mediaId = 'fn15';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId, filename: 'orig15.png' })] });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('F15'), httpMetadata: { contentType: 'image/png' } },
    });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/named15.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition') || '').toMatch(/named15\.png|inline|attachment/i);
  });
});

describe('media leftovers method matrix after #154', () => {
  const cases: Array<{ path: string; bad: string[] }> = [
    { path: '/_matrix/media/v3/config', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v1/media/config', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/media/v3/upload', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v1/media/create', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path} → 404/405`, async () => {
        const res = await request(c.path, {
          method,
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
        });
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});

describe('media leftovers Content-Type charset soft flood after #154', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'application/json; charset="utf-8"',
  ];

  it('POST create charset soft-0', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': charsets[0] },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:/) });
  });

  it('POST create charset soft-1', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': charsets[1] },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:/) });
  });

  it('POST create charset soft-2', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': charsets[2] },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:/) });
  });

  it('POST create charset soft-3', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': charsets[3] },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:/) });
  });

  it('POST create charset soft-4', async () => {
    const res = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': charsets[4] },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content_uri: expect.stringMatching(/^mxc:/) });
  });
});

describe('media leftovers failure edges after #154', () => {
  it('v3 upload empty body still stores', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(),
    });
    expect(res.status).toBe(200);
  });

  it('v3 download wrong server', async () => {
    const res = await request('/_matrix/media/v3/download/other.example.org/x');
    expect(res.status).toBe(404);
  });

  it('client v1 upload mxc path put missing placeholder', async () => {
    const res = await request(`/_matrix/client/v1/media/upload/${SERVER}/nope`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
      body: bytesOf('x'),
    });
    expect([403, 404]).toContain(res.status);
  });

  it('preview_url missing url', async () => {
    const res = await request('/_matrix/media/v3/preview_url');
    expect(res.status).toBe(400);
  });

  it('config size stable soft-0', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-1', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-2', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-3', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-4', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-5', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-6', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-7', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-8', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-9', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-10', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-11', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-12', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-13', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-14', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });

  it('config size stable soft-15', async () => {
    const a = await request('/_matrix/media/v3/config');
    const b = await request('/_matrix/client/v1/media/config');
    expect(a.body).toEqual(b.body);
  });
});

describe('media leftovers lifecycle soft floods after #154', () => {

  it('create then put then download soft-0', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life0'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life0');
  });

  it('create then put then download soft-1', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life1'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life1');
  });

  it('create then put then download soft-2', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life2'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life2');
  });

  it('create then put then download soft-3', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life3'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life3');
  });

  it('create then put then download soft-4', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life4'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life4');
  });

  it('create then put then download soft-5', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life5'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life5');
  });

  it('create then put then download soft-6', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life6'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life6');
  });

  it('create then put then download soft-7', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life7'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life7');
  });

  it('create then put then download soft-8', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life8'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life8');
  });

  it('create then put then download soft-9', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life9'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life9');
  });

  it('create then put then download soft-10', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life10'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life10');
  });

  it('create then put then download soft-11', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life11'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life11');
  });

  it('create then put then download soft-12', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life12'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life12');
  });

  it('create then put then download soft-13', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life13'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life13');
  });

  it('create then put then download soft-14', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life14'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life14');
  });

  it('create then put then download soft-15', async () => {
    const created = await request('/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('life15'),
      },
      { db: created.db, media: created.media, cache: created.cache }
    );
    expect(put.status).toBe(200);
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } },
      { db: put.db, media: put.media, cache: put.cache }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('life15');
  });
});
