/**
 * TOKENMAXX HEAVY deepen after #109/#111 — media API route edges (media/v3 + MSC3916 client/v1).
 * Continues the media route slice from #109; avoids identity/federation (#111), oauth (#106), push (#107).
 * Helper-only coverage lives in media-helpers.test.ts — this file exercises Hono app.request().
 * Tests-only — no product inventing.
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
const REMOTE = 'remote.org';
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

describe('media GET /_matrix/media/v3/config', () => {
  it('returns m.upload.size without auth', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('reports the 50MB constant', async () => {
    const res = await request('/_matrix/media/v3/config');
    expect((res.body as { 'm.upload.size': number })['m.upload.size']).toBe(52_428_800);
  });
});

// ============================================
// media/v3 upload
// ============================================

describe('media POST /_matrix/media/v3/upload', () => {
  it('uploads bytes, stores R2+D1, returns mxc URI', async () => {
    const body = bytesOf('PNGDATA');
    const res = await request('/_matrix/media/v3/upload?filename=photo.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content_uri: `mxc://${SERVER}/mediaid10000000000000000` });
    expect(res.media.puts).toHaveLength(1);
    expect(res.media.puts[0].key).toBe('mediaid10000000000000000');
    expect(res.media.puts[0].options).toMatchObject({
      httpMetadata: { contentType: 'image/png' },
      customMetadata: {
        userId: USER,
        filename: 'photo.png',
        uploadedAt: String(Date.now()),
      },
    });
    expect(res.db.rows).toHaveLength(1);
    expect(res.db.rows[0]).toMatchObject({
      media_id: 'mediaid10000000000000000',
      user_id: USER,
      content_type: 'image/png',
      content_length: body.byteLength,
      filename: 'photo.png',
    });
  });

  it('defaults Content-Type to application/octet-stream', async () => {
    const body = bytesOf('raw');
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Length': String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
    expect(res.db.rows[0].filename).toBeNull();
  });

  it('sanitizes unsafe filename query param before storage', async () => {
    const body = bytesOf('x');
    const res = await request('/_matrix/media/v3/upload?filename=../evil%0d%0aX.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].filename).toBe('.._evil__X.png');
    expect(
      (res.media.puts[0].options as { customMetadata: { filename: string } }).customMetadata.filename
    ).toBe('.._evil__X.png');
  });

  it('rejects unsupported MIME types with M_FORBIDDEN', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', 'Content-Length': '2' },
      body: bytesOf('<>'),
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Unsupported content type: text/html',
    });
    expect(res.media.puts).toHaveLength(0);
    expect(res.db.rows).toHaveLength(0);
  });

  it('strips MIME parameters when validating Content-Type', async () => {
    const body = bytesOf('ok');
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg; charset=binary',
        'Content-Length': String(body.byteLength),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].content_type).toBe('image/jpeg; charset=binary');
  });

  it('rejects Content-Length above MAX_UPLOAD_SIZE early', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(MAX_UPLOAD_SIZE + 1),
      },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      errcode: 'M_TOO_LARGE',
      error: 'File exceeds maximum upload size',
    });
    expect(res.media.puts).toHaveLength(0);
  });

  it('rejects when actual body exceeds MAX_UPLOAD_SIZE even if Content-Length is low', async () => {
    // Build a body just over the limit without allocating 50MB+ of real data by
    // temporarily mocking arrayBuffer on the Request path via a tiny oversized buffer
    // and patching MAX path: we can't change the constant, so skip true 50MB alloc.
    // Instead verify Content-Length early path already covered and body-size path via spy.
    const oversized = new ArrayBuffer(MAX_UPLOAD_SIZE + 1);
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        // Claim small so early Content-Length check passes
        'Content-Length': '1',
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ errcode: 'M_TOO_LARGE' });
    expect(res.media.puts).toHaveLength(0);
  });

  it('accepts video/mp4 and application/pdf whitelist members', async () => {
    for (const contentType of ['video/mp4', 'application/pdf', 'audio/ogg', 'image/webp']) {
      opaqueSeq = 0;
      const body = bytesOf(contentType);
      const res = await request('/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': String(body.byteLength) },
        body,
      });
      expect(res.status).toBe(200);
      expect(res.db.rows[0].content_type).toBe(contentType);
    }
  });

  it('stores empty filename as empty string in R2 customMetadata when omitted', async () => {
    const body = bytesOf('z');
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '1' },
      body,
    });
    expect(res.status).toBe(200);
    expect(
      (res.media.puts[0].options as { customMetadata: { filename: string } }).customMetadata.filename
    ).toBe('');
  });
});

// ============================================
// media/v3 download
// ============================================

describe('media GET /_matrix/media/v3/download/:serverName/:mediaId', () => {
  it('serves local media with security + disposition headers', async () => {
    const mediaId = 'abc123';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, filename: 'shot.png', content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: bytesOf('IMAGEDATA') },
    });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('IMAGEDATA');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="shot.png"');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('defaults Content-Type when D1 metadata missing', async () => {
    const mediaId = 'orphan';
    const media = createMediaBucket({ [mediaId]: { body: 'blob' } });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}`,
      {},
      { db: createMediaDb(), media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('returns 404 for remote serverName', async () => {
    const res = await request(`/_matrix/media/v3/download/${REMOTE}/abc`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'Remote media not supported',
    });
  });

  it('returns 404 when R2 object missing', async () => {
    const db = createMediaDb({ rows: [seedRow({ media_id: 'gone' })] });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/gone`, {}, { db });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Media not found' });
  });

  it('omits Content-Disposition when filename is null', async () => {
    const mediaId = 'nofn';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, filename: null, content_type: 'audio/mpeg' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'mp3' } });
    const res = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });
});

describe('media GET /_matrix/media/v3/download/:serverName/:mediaId/:filename', () => {
  it('uses requested filename in Content-Disposition (sanitized)', async () => {
    const mediaId = 'fn1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'jpg' } });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/my photo.jpg`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="my_photo.jpg"');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('rejects remote server and missing object', async () => {
    const remote = await request(`/_matrix/media/v3/download/${REMOTE}/x/a.png`);
    expect(remote.status).toBe(404);
    expect(remote.body).toMatchObject({ error: 'Remote media not supported' });

    const missing = await request(`/_matrix/media/v3/download/${SERVER}/missing/a.png`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'Media not found' });
  });

  it('falls back to octet-stream without D1 row', async () => {
    const mediaId = 'onlyr2';
    const media = createMediaBucket({ [mediaId]: { body: 'z' } });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/file.bin`,
      {},
      { media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="file.bin"');
  });
});

// ============================================
// media/v3 thumbnail
// ============================================

describe('media GET /_matrix/media/v3/thumbnail/:serverName/:mediaId', () => {
  it('returns 404 for remote server', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${REMOTE}/x?width=32&height=32`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Remote media not supported' });
  });

  it('returns 404 when media metadata missing', async () => {
    const res = await request(`/_matrix/media/v3/thumbnail/${SERVER}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Media not found' });
  });

  it('serves pre-generated thumbnail from R2 when present', async () => {
    const mediaId = 'img1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const thumbKey = `thumb_${mediaId}_96x96_scale`;
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIGINAL' },
      [thumbKey]: { body: 'THUMBJPEG' },
    });
    const res = await request(`/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMBJPEG');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(media.gets).toContain(thumbKey);
  });

  it('returns original for non-image content types', async () => {
    const mediaId = 'pdf1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: '%PDF' } });
    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('%PDF');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('returns 404 when original R2 object missing after metadata hit', async () => {
    const mediaId = 'metaonly';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}`,
      {},
      { db, media: createMediaBucket() }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Media not found' });
  });

  it('generates and caches thumbnail when cf.image fetch succeeds', async () => {
    const mediaId = 'resize1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    const fetchMock = vi.fn(async () => new Response(bytesOf('JPEGTHUMB'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=120&height=80&method=crop`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('JPEGTHUMB');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://${SERVER}/_matrix/media/v3/download/${SERVER}/${mediaId}`,
      expect.objectContaining({
        cf: {
          image: {
            width: 120,
            height: 80,
            fit: 'cover',
            format: 'jpeg',
            quality: 85,
          },
        },
      })
    );
    const thumbKey = `thumb_${mediaId}_120x80_crop`;
    expect(media.store.has(thumbKey)).toBe(true);
  });

  it('falls back to original with X-Thumbnail-Generated false when resize fails', async () => {
    const mediaId = 'resizefail';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/webp' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'WEBP' } });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Image Resizing unavailable');
    }));

    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?method=scale`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('WEBP');
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
  });

  it('falls back when resize returns non-ok status', async () => {
    const mediaId = 'resize404';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/gif' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'GIF' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));

    const res = await request(`/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('GIF');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
  });

  it('clamps width/height query params into thumbnail key', async () => {
    const mediaId = 'clamp';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    // width=0 → fallback 96; height=99999 → 1920; method default scale
    const thumbKey = `thumb_${mediaId}_96x1920_scale`;
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [thumbKey]: { body: 'CACHED' },
    });
    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=0&height=99999`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('CACHED');
    expect(media.gets).toContain(thumbKey);
  });
});

// ============================================
// media/v3 preview_url
// ============================================

describe('media GET /_matrix/media/v3/preview_url', () => {
  it('requires url query param', async () => {
    const res = await request('/_matrix/media/v3/preview_url');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: url',
    });
  });

  it('rejects SSRF / blocked hosts', async () => {
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://127.0.0.1/secret')}`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(String((res.body as { error: string }).error).length).toBeGreaterThan(0);
  });

  it('rejects localhost hostname', async () => {
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://localhost/x')}`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('returns cached preview without fetching', async () => {
    const url = 'https://example.org/page';
    const cache = createCache({
      [`preview:${url}`]: JSON.stringify({ 'og:title': 'Cached' }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { cache }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches image URL previews', async () => {
    const url = 'https://cdn.example.org/a.png';
    const fetchMock = vi.fn(
      async () =>
        new Response(bytesOf('PNG'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(res.cache.puts).toEqual([
      {
        key: `preview:${url}`,
        value: JSON.stringify({ 'og:image': url, 'og:image:type': 'image/png' }),
        options: { expirationTtl: 3600 },
      },
    ]);
  });

  it('returns empty object for non-HTML non-image content', async () => {
    const url = 'https://cdn.example.org/file.json';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.cache.puts).toHaveLength(0);
  });

  it('returns empty object when upstream is not ok', async () => {
    const url = 'https://cdn.example.org/missing';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('parses Open Graph tags from HTML and caches', async () => {
    const url = 'https://news.example.org/story';
    const html = `
      <html><head>
        <meta property="og:title" content="Hello &amp; World" />
        <meta property="og:description" content="Desc" />
        <meta property="og:image" content="/img.png" />
        <meta property="og:site_name" content="News" />
        <meta property="og:type" content="article" />
      </head></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      'og:title': 'Hello & World',
      'og:description': 'Desc',
      'og:image': 'https://news.example.org/img.png',
      'og:site_name': 'News',
      'og:type': 'article',
    });
    expect(res.cache.puts[0]?.options).toEqual({ expirationTtl: 3600 });
  });

  it('falls back to title/description meta when og tags absent', async () => {
    const url = 'https://plain.example.org/';
    const html = `<html><head><title>Plain</title><meta name="description" content="D"></head></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      )
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.body).toEqual({ 'og:title': 'Plain', 'og:description': 'D' });
  });

  it('returns empty object and does not cache empty HTML previews', async () => {
    const url = 'https://empty.example.org/';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.cache.puts).toHaveLength(0);
  });

  it('returns {} on fetch abort / network error', async () => {
    const url = 'https://slow.example.org/';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('aborted');
      })
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('uses Browser Rendering when BROWSER binding is present', async () => {
    const url = 'https://spa.example.org/app';
    const browserHtml =
      '<html><head><meta property="og:title" content="FromBrowser"></head></html>';
    const fetchMock = vi.fn(
      async () =>
        new Response('<html><title>Basic</title></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const browser = {
      fetch: vi.fn(async () => new Response(browserHtml, { status: 200 })),
    };
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'FromBrowser' });
    expect(browser.fetch).toHaveBeenCalled();
  });

  it('falls back to basic fetch HTML when Browser Rendering fails', async () => {
    const url = 'https://spa.example.org/fail';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><title>FallbackTitle</title></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const browser = {
      fetch: vi.fn(async () => {
        throw new Error('browser down');
      }),
    };
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.body).toEqual({ 'og:title': 'FallbackTitle' });
  });

  it('falls back when Browser Rendering returns non-ok', async () => {
    const url = 'https://spa.example.org/nok';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><title>BasicOk</title></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const browser = {
      fetch: vi.fn(async () => new Response('err', { status: 500 })),
    };
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.body).toEqual({ 'og:title': 'BasicOk' });
  });

  it('ignores unused ts cache-bust query param', async () => {
    const url = 'https://cdn.example.org/i.png';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      )
    );
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}&ts=12345`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ 'og:image': url });
  });
});

// ============================================
// client/v1 config + upload
// ============================================

describe('media GET /_matrix/client/v1/media/config', () => {
  it('returns authenticated media config', async () => {
    const res = await request('/_matrix/client/v1/media/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });
});

describe('media POST /_matrix/client/v1/media/upload', () => {
  it('mirrors v3 upload success path with mxc URI', async () => {
    const body = bytesOf('V1PNG');
    const res = await request('/_matrix/client/v1/media/upload?filename=a.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content_uri: `mxc://${SERVER}/mediaid10000000000000000` });
    expect(res.db.rows[0]).toMatchObject({
      user_id: USER,
      content_type: 'image/png',
      filename: 'a.png',
      content_length: body.byteLength,
    });
  });

  it('rejects unsupported types and oversized Content-Length', async () => {
    const badType = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-msdownload', 'Content-Length': '1' },
      body: bytesOf('x'),
    });
    expect(badType.status).toBe(403);
    expect(badType.body).toMatchObject({ errcode: 'M_FORBIDDEN' });

    const tooBig = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_UPLOAD_SIZE + 100),
      },
      body: bytesOf('x'),
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ errcode: 'M_TOO_LARGE' });
  });

  it('rejects oversized actual body on client/v1 upload', async () => {
    const oversized = new ArrayBuffer(MAX_UPLOAD_SIZE + 2);
    const res = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '2' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(res.media.puts).toHaveLength(0);
  });

  it('defaults Content-Type and null filename like v3', async () => {
    const body = bytesOf('bin');
    const res = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: { 'Content-Length': String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].content_type).toBe('application/octet-stream');
    expect(res.db.rows[0].filename).toBeNull();
  });
});

// ============================================
// client/v1 create + PUT upload placeholder
// ============================================

describe('media POST /_matrix/client/v1/media/create', () => {
  it('creates placeholder with unused_expires_at 24h ahead', async () => {
    const now = Date.now();
    const res = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = res.body as { content_uri: string; unused_expires_at: number };
    expect(body.content_uri).toBe(`mxc://${SERVER}/mediaid10000000000000000`);
    expect(body.unused_expires_at).toBe(now + 24 * 60 * 60 * 1000);
    expect(res.db.rows[0]).toMatchObject({
      media_id: 'mediaid10000000000000000',
      user_id: USER,
      content_type: 'application/octet-stream',
      content_length: 0,
      filename: null,
    });
    expect(res.media.puts).toHaveLength(0);
  });

  it('issues distinct media ids across creates', async () => {
    const a = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    const b = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    expect((a.body as { content_uri: string }).content_uri).not.toBe(
      (b.body as { content_uri: string }).content_uri
    );
  });
});

describe('media PUT /_matrix/client/v1/media/upload/:serverName/:mediaId', () => {
  it('uploads into owned empty placeholder', async () => {
    const mediaId = 'ph1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
    });
    const media = createMediaBucket();
    const body = bytesOf('FILL');
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}?filename=doc.pdf`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body,
      },
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(media.puts).toHaveLength(1);
    expect(media.puts[0].key).toBe(mediaId);
    expect(db.rows[0]).toMatchObject({
      content_type: 'application/pdf',
      content_length: body.byteLength,
      filename: 'doc.pdf',
    });
    expect(db.updates).toHaveLength(1);
  });

  it('rejects remote serverName', async () => {
    const res = await request(`/_matrix/client/v1/media/upload/${REMOTE}/ph`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot upload to remote server',
    });
  });

  it('returns 404 when placeholder missing', async () => {
    const res = await request(`/_matrix/client/v1/media/upload/${SERVER}/missing`, {
      method: 'PUT',
      body: bytesOf('x'),
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Media not found' });
  });

  it('forbids uploading to another user placeholder', async () => {
    const mediaId = 'otherph';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, user_id: OTHER, content_length: 0 })],
    });
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', body: bytesOf('x') },
      { db }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not authorized to upload to this media',
    });
  });

  it('returns M_CANNOT_OVERWRITE_MEDIA when content_length already set', async () => {
    const mediaId = 'filled';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 10 })],
    });
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', body: bytesOf('x') },
      { db }
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      errcode: 'M_CANNOT_OVERWRITE_MEDIA',
      error: 'Media already uploaded',
    });
  });

  it('defaults Content-Type and null filename on placeholder fill', async () => {
    const mediaId = 'ph2';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0 })],
    });
    const media = createMediaBucket();
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', body: bytesOf('zz') },
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(db.rows[0].content_type).toBe('application/octet-stream');
    expect(db.rows[0].filename).toBeNull();
    expect(
      (media.puts[0].options as { customMetadata: { filename: string } }).customMetadata.filename
    ).toBe('');
  });
});

// ============================================
// client/v1 download
// ============================================

describe('media GET /_matrix/client/v1/media/download/:serverName/:mediaId', () => {
  it('requires auth path and serves with security headers', async () => {
    const mediaId = 'v1d';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, filename: 'f.webp', content_type: 'image/webp' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'WEBP' } });
    const res = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('WEBP');
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="f.webp"');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('404s remote and missing objects', async () => {
    const remote = await request(`/_matrix/client/v1/media/download/${REMOTE}/x`);
    expect(remote.status).toBe(404);
    expect(remote.body).toMatchObject({ error: 'Remote media not supported' });

    const missing = await request(`/_matrix/client/v1/media/download/${SERVER}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'Media not found' });
  });

  it('defaults Content-Type without D1 metadata', async () => {
    const mediaId = 'r2only';
    const media = createMediaBucket({ [mediaId]: { body: 'b' } });
    const res = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      {},
      { media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });
});

describe('media GET /_matrix/client/v1/media/download/:serverName/:mediaId/:filename', () => {
  it('applies requested filename disposition', async () => {
    const mediaId = 'v1fn';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'text/plain' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'hi' } });
    const res = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}/notes.txt`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="notes.txt"');
    expect(res.headers.get('Content-Type')).toBe('text/plain');
  });

  it('404s remote and missing', async () => {
    expect((await request(`/_matrix/client/v1/media/download/${REMOTE}/x/a`)).status).toBe(404);
    expect((await request(`/_matrix/client/v1/media/download/${SERVER}/x/a`)).status).toBe(404);
  });
});

// ============================================
// client/v1 thumbnail
// ============================================

describe('media GET /_matrix/client/v1/media/thumbnail/:serverName/:mediaId', () => {
  it('404s remote and missing metadata', async () => {
    expect((await request(`/_matrix/client/v1/media/thumbnail/${REMOTE}/x`)).status).toBe(404);
    expect((await request(`/_matrix/client/v1/media/thumbnail/${SERVER}/x`)).status).toBe(404);
  });

  it('serves cached thumb JPEG', async () => {
    const mediaId = 't1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const key = `thumb_${mediaId}_96x96_scale`;
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [key]: { body: 'T' },
    });
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('T');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('returns original for non-image without X-Thumbnail-Generated', async () => {
    const mediaId = 'audio';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'audio/wav' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'WAV' } });
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('WAV');
    expect(res.headers.get('Content-Type')).toBe('audio/wav');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('404s when R2 original missing', async () => {
    const mediaId = 'meta';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}`,
      {},
      { db }
    );
    expect(res.status).toBe(404);
  });

  it('generates thumb via cf.image and caches', async () => {
    const mediaId = 'gen';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('JPG'), { status: 200 })));
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=10&height=10&method=crop`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(`thumb_${mediaId}_10x10_crop`)).toBe(true);
  });

  it('sets X-Thumbnail-Generated false on resize failure for images', async () => {
    const mediaId = 'fail';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no resize');
    }));
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
    expect(res.text).toBe('PNG');
  });

  it('falls back when resize returns non-ok', async () => {
    const mediaId = 'nok';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}`,
      {},
      { db, media }
    );
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
  });
});

// ============================================
// client/v1 preview_url
// ============================================

describe('media GET /_matrix/client/v1/media/preview_url', () => {
  it('requires url', async () => {
    const res = await request('/_matrix/client/v1/media/preview_url');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects invalid / SSRF URLs', async () => {
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://192.168.1.1/')}`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('returns cache hit', async () => {
    const url = 'https://cached.example.org/';
    const cache = createCache({ [`preview:${url}`]: JSON.stringify({ 'og:title': 'Hit' }) });
    vi.stubGlobal('fetch', vi.fn());
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { cache }
    );
    expect(res.body).toEqual({ 'og:title': 'Hit' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('caches image previews', async () => {
    const url = 'https://img.example.org/x.gif';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('g', { status: 200, headers: { 'Content-Type': 'image/gif' } }))
    );
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`
    );
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/gif' });
    expect(res.cache.puts[0]?.options?.expirationTtl).toBe(3600);
  });

  it('returns {} for non-html', async () => {
    const url = 'https://files.example.org/a.bin';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('bin', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
      )
    );
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`
    );
    expect(res.body).toEqual({});
  });

  it('returns {} on upstream error status', async () => {
    const url = 'https://files.example.org/404';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`
    );
    expect(res.body).toEqual({});
  });

  it('parses HTML OG and caches non-empty preview', async () => {
    const url = 'https://blog.example.org/p';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html><head><meta property="og:title" content="T"><meta property="og:image" content="https://cdn.example.org/a.png"></head></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } }
          )
      )
    );
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`
    );
    expect(res.body).toEqual({
      'og:title': 'T',
      'og:image': 'https://cdn.example.org/a.png',
    });
    expect(res.cache.puts).toHaveLength(1);
  });

  it('does not cache empty HTML preview', async () => {
    const url = 'https://blog.example.org/empty';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`
    );
    expect(res.body).toEqual({});
    expect(res.cache.puts).toHaveLength(0);
  });

  it('returns {} on network failure', async () => {
    const url = 'https://blog.example.org/err';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      })
    );
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`
    );
    expect(res.body).toEqual({});
  });
});

// ============================================
// Cross-cutting / TOKENMAXX edges
// ============================================

describe('media API TOKENMAXX cross-cutting edges after #107', () => {
  it('v3 and v1 configs agree on upload size', async () => {
    const v3 = await request('/_matrix/media/v3/config');
    const v1 = await request('/_matrix/client/v1/media/config');
    expect(v3.body).toEqual(v1.body);
  });

  it('create → put → download round-trip on client/v1', async () => {
    const created = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    const mediaId = (created.body as { content_uri: string }).content_uri.split('/').pop()!;
    const db = created.db;
    const media = created.media;

    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}?filename=round.png`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: bytesOf('ROUND'),
      },
      { db, media }
    );
    expect(put.status).toBe(200);

    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      {},
      { db, media }
    );
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('ROUND');
    expect(dl.headers.get('Content-Disposition')).toBe('inline; filename="round.png"');
  });

  it('v3 download filename path sanitizes header-injection names', async () => {
    const mediaId = 'inj';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'x' } });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/${encodeURIComponent('a\r\nSet-Cookie: x=1.png')}`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline; filename="/);
    expect(res.headers.get('Content-Disposition')).not.toContain('\r');
    expect(res.headers.get('Content-Disposition')).not.toContain('\n');
  });

  it('thumbnail method scale maps to contain fit', async () => {
    const mediaId = 'fit';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    const fetchMock = vi.fn(async () => new Response(bytesOf('J'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=8&height=8&method=scale`,
      {},
      { db, media }
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cf: { image: { fit: 'contain' } },
    });
  });

  it('rejects file:// and non-http schemes in preview_url', async () => {
    const fileRes = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('file:///etc/passwd')}`
    );
    expect(fileRes.status).toBe(400);
    const ftpRes = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('ftp://example.org/x')}`
    );
    expect(ftpRes.status).toBe(400);
  });

  it('v3 upload stores created_at near mocked now', async () => {
    const body = bytesOf('t');
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '1' },
      body,
    });
    expect(res.db.rows[0].created_at).toBe(Date.now());
  });

  it('placeholder put refuses content_length exactly 1 as already uploaded', async () => {
    const mediaId = 'tiny';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 1 })],
    });
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', body: bytesOf('y') },
      { db }
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errcode: 'M_CANNOT_OVERWRITE_MEDIA' });
  });

  it('allows application/json and image/svg+xml uploads', async () => {
    for (const ct of ['application/json', 'image/svg+xml']) {
      opaqueSeq = 0;
      const body = bytesOf('{}');
      const res = await request('/_matrix/client/v1/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': ct, 'Content-Length': String(body.byteLength) },
        body,
      });
      expect(res.status).toBe(200);
    }
  });

  it('v1 download with filename falls back to octet-stream without metadata', async () => {
    const mediaId = 'nometa';
    const media = createMediaBucket({ [mediaId]: { body: 'z' } });
    const res = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}/z.bin`,
      {},
      { media }
    );
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="z.bin"');
  });

  it('preview_url shares cache key namespace between v3 and v1', async () => {
    const url = 'https://share.example.org/p';
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><title>Shared</title></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const first = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { cache }
    );
    expect(first.body).toEqual({ 'og:title': 'Shared' });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const second = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { cache }
    );
    expect(second.body).toEqual({ 'og:title': 'Shared' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('absolutizes protocol-relative-ish relative og:image without leading slash', async () => {
    const url = 'https://imghost.example.org/page';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html><head><meta property="og:image" content="assets/hero.png"></head></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } }
          )
      )
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.body).toEqual({
      'og:image': 'https://imghost.example.org/assets/hero.png',
    });
  });

  it('v3 thumbnail crop uses cover fit; unknown method uses contain', async () => {
    const mediaId = 'methods';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    const fetchMock = vi.fn(async () => new Response(bytesOf('J'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=1&height=1&method=crop`,
      {},
      { db, media }
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cf: { image: { fit: 'cover' } },
    });

    opaqueSeq = 0;
    media.store.delete(`thumb_${mediaId}_1x1_crop`);
    await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=1&height=1&method=weird`,
      {},
      { db, media }
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      cf: { image: { fit: 'contain' } },
    });
  });
});


// ============================================
// TOKENMAXX HEAVY media route edges after #109/#111
// Fresh deepen from latest main (PR #110 closed conflicting).
// ============================================

describe('media API TOKENMAXX edges after #109/#111 — upload MIME matrix', () => {
  const accepted = [
    'image/gif',
    'image/svg+xml',
    'video/webm',
    'audio/mp3',
    'audio/mpeg',
    'audio/wav',
    'audio/webm',
    'application/json',
    'text/plain',
    'application/octet-stream',
  ];

  it.each(accepted)('accepts whitelist MIME %s on v3 upload', async (contentType) => {
    opaqueSeq = 0;
    const body = bytesOf('x');
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].content_type).toBe(contentType);
  });

  it.each([
    'text/css',
    'text/javascript',
    'application/javascript',
    'image/bmp',
    'image/tiff',
    'audio/flac',
    'video/avi',
    'multipart/form-data',
    'application/zip',
  ])('rejects non-whitelist MIME %s', async (contentType) => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': '1' },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(res.media.puts).toHaveLength(0);
  });

  it('rejects uppercase IMAGE/PNG as case-sensitive whitelist miss', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'IMAGE/PNG', 'Content-Length': '1' },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('trims whitespace around base MIME before whitelist check', async () => {
    const body = bytesOf('x');
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: {
        'Content-Type': '  image/png ; charset=binary',
        'Content-Length': String(body.byteLength),
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  it('rejects leading-semicolon Content-Type that parses to empty base', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': ';charset=utf-8', 'Content-Length': '1' },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(403);
  });
});

describe('media API TOKENMAXX edges after #109/#111 — filename + disposition', () => {
  it('truncates filenames longer than 255 chars on upload', async () => {
    const long = `${'a'.repeat(300)}.png`;
    const body = bytesOf('x');
    const res = await request(`/_matrix/media/v3/upload?filename=${encodeURIComponent(long)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].filename).toHaveLength(255);
    expect(
      (res.media.puts[0].options as { customMetadata: { filename: string } }).customMetadata.filename
    ).toHaveLength(255);
  });

  it('sanitizes unicode and spaces in download-with-filename disposition', async () => {
    const mediaId = 'fn1';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'x' } });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/${encodeURIComponent('写真 file.png')}`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="___file.png"');
  });

  it('applies security headers on v3 download-with-filename', async () => {
    const mediaId = 'secfn';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'x' } });
    const res = await request(
      `/_matrix/media/v3/download/${SERVER}/${mediaId}/a.png`,
      {},
      { db, media }
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });

  it('v1 download-with-filename also sets security + cache headers', async () => {
    const mediaId = 'v1sec';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'x' } });
    const res = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}/b.png`,
      {},
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toContain('max-age=31536000');
  });
});

describe('media API TOKENMAXX edges after #109/#111 — serverName gates', () => {
  it('treats SERVER_NAME comparison as exact (case-sensitive) on v3 download', async () => {
    const mediaId = 'case';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'x' } });
    const res = await request(
      `/_matrix/media/v3/download/Example.Com/${mediaId}`,
      {},
      { db, media, serverName: 'example.com' }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('rejects remote serverName on v1 thumbnail', async () => {
    const res = await request(`/_matrix/client/v1/media/thumbnail/${REMOTE}/x`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('rejects remote serverName on v1 download-with-filename', async () => {
    const res = await request(`/_matrix/client/v1/media/download/${REMOTE}/x/a.png`);
    expect(res.status).toBe(404);
  });

  it('forbids placeholder PUT to mismatched serverName', async () => {
    const mediaId = 'remoteput';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0 })],
    });
    const res = await request(
      `/_matrix/client/v1/media/upload/${REMOTE}/${mediaId}`,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytesOf('x') },
      { db }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('media API TOKENMAXX edges after #109/#111 — thumbnail clamps + methods', () => {
  it('defaults missing width/height to 96 in cache key', async () => {
    const mediaId = 'def96';
    const thumbKey = `thumb_${mediaId}_96x96_scale`;
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [thumbKey]: { body: 'T' },
    });
    const res = await request(`/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.text).toBe('T');
    expect(media.gets).toContain(thumbKey);
  });

  it('clamps negative and NaN dimension strings via parseInt fallback', async () => {
    const mediaId = 'nan';
    // width=-5 → parseInt truthy → Math.max(1,-5)=1; height=abc → NaN → fallback 96
    const thumbKey = `thumb_${mediaId}_1x96_scale`;
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [thumbKey]: { body: 'CACHED' },
    });
    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=-5&height=abc`,
      {},
      { db, media }
    );
    expect(res.text).toBe('CACHED');
  });

  it('maps method=crop to cover and unknown methods to contain on v3', async () => {
    const mediaId = 'fitmap';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    const fetchMock = vi.fn(async () => new Response(bytesOf('J'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=2&height=2&method=crop`,
      {},
      { db, media }
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cf: { image: { fit: 'cover', width: 2, height: 2, format: 'jpeg', quality: 85 } },
    });

    await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=2&height=2&method=SCALE`,
      {},
      { db, media }
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      cf: { image: { fit: 'contain' } },
    });
  });

  it('does not set X-Thumbnail-Generated when serving cached thumb', async () => {
    const mediaId = 'cachedhdr';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({
      [mediaId]: { body: 'O' },
      [thumbKey]: { body: 'JPEG' },
    });
    const res = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      {},
      { db, media }
    );
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('v1 thumbnail clamps width=99999 to 1920 in generated key', async () => {
    const mediaId = 'v1clamp';
    const db = createMediaDb({ rows: [seedRow({ media_id: mediaId })] });
    const media = createMediaBucket({ [mediaId]: { body: 'PNG' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('J'), { status: 200 })));
    const res = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=99999&height=1&method=scale`,
      {},
      { db, media }
    );
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(`thumb_${mediaId}_1920x1_scale`)).toBe(true);
  });
});

describe('media API TOKENMAXX edges after #109/#111 — preview_url SSRF + OG', () => {
  it.each([
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.16.5.5/',
    'http://192.168.100.1/',
    'http://metadata.google.internal/',
    'https://example.org:22/',
    'https://example.org:3306/',
    'ftp://example.org/x',
    'file:///etc/passwd',
  ])('rejects SSRF / blocked preview url %s', async (url) => {
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('allows public https and caches og:site_name + og:type', async () => {
    const url = 'https://public.example.org/article';
    const html = `
      <html><head>
        <meta property="og:title" content="T" />
        <meta property="og:site_name" content="Site &amp; Co" />
        <meta property="og:type" content="article" />
      </head></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.body).toMatchObject({
      'og:title': 'T',
      'og:site_name': 'Site & Co',
      'og:type': 'article',
    });
    expect(res.cache.puts[0]?.key).toBe(`preview:${url}`);
  });

  it('leaves absolute http(s) og:image unchanged', async () => {
    const url = 'https://public.example.org/p';
    const html =
      '<meta property="og:image" content="https://cdn.example.org/a.png" />';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.body).toEqual({ 'og:image': 'https://cdn.example.org/a.png' });
  });

  it('absolutizes root-relative og:image against request host', async () => {
    const url = 'https://blog.example.org/posts/1';
    const html = '<meta property="og:image" content="/static/hero.png" />';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.body).toEqual({ 'og:image': 'https://blog.example.org/static/hero.png' });
  });

  it('reads content-before-property meta attribute order', async () => {
    const url = 'https://blog.example.org/order';
    const html = '<meta content="Hello" property="og:title" />';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const res = await request(`/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`);
    expect(res.body).toEqual({ 'og:title': 'Hello' });
  });

  it('v1 preview_url rejects unusual ports even on public hosts', async () => {
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('https://example.org:9000/')}`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('v1 preview_url does not use BROWSER binding (basic fetch only)', async () => {
    const url = 'https://spa.example.org/';
    const browser = {
      fetch: vi.fn(async () => new Response('<meta property="og:title" content="Browser" />', { status: 200 })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Basic" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.body).toEqual({ 'og:title': 'Basic' });
    expect(browser.fetch).not.toHaveBeenCalled();
  });
});

describe('media API TOKENMAXX edges after #109/#111 — placeholder lifecycle', () => {
  it('allows content_length === 0 placeholder fill and then blocks overwrite', async () => {
    const created = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    const mediaId = (created.body as { content_uri: string }).content_uri.split('/').pop()!;
    const db = created.db;
    const media = created.media;

    const first = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: bytesOf('one'),
      },
      { db, media }
    );
    expect(first.status).toBe(200);
    expect(db.rows[0].content_length).toBe(3);

    const second = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: bytesOf('two'),
      },
      { db, media }
    );
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ errcode: 'M_CANNOT_OVERWRITE_MEDIA' });
  });

  it('forbids filling another user empty placeholder', async () => {
    const mediaId = 'otherph';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, user_id: OTHER, content_length: 0 })],
    });
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytesOf('x') },
      { db }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('returns 404 when filling unknown placeholder id', async () => {
    const res = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/missing`,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytesOf('x') },
      { db: createMediaDb() }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('create unused_expires_at tracks fake system time', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const res = await request('/_matrix/client/v1/media/create', { method: 'POST' });
    expect((res.body as { unused_expires_at: number }).unused_expires_at).toBe(
      Date.parse('2026-01-02T00:00:00.000Z')
    );
  });
});

describe('media API TOKENMAXX edges after #109/#111 — cross-route integration', () => {
  it('v3 upload then v1 thumbnail resize path', async () => {
    const up = await request('/_matrix/media/v3/upload?filename=x.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      body: bytesOf('PNG'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytesOf('JPG'), { status: 200 })));
    const thumb = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=16&height=16&method=crop`,
      {},
      { db: up.db, media: up.media }
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(up.media.store.has(`thumb_${mediaId}_16x16_crop`)).toBe(true);
  });

  it('v1 upload then v3 download preserves content type and disposition', async () => {
    const up = await request('/_matrix/client/v1/media/upload?filename=note.txt', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '4' },
      body: bytesOf('note'),
    });
    const mediaId = (up.body as { content_uri: string }).content_uri.split('/').pop()!;
    const dl = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, {
      db: up.db,
      media: up.media,
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Type')).toBe('text/plain');
    expect(dl.headers.get('Content-Disposition')).toBe('inline; filename="note.txt"');
    expect(dl.text).toBe('note');
  });

  it('preview cache is shared across v3 and v1 routes', async () => {
    const url = 'https://share2.example.org/p';
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Shared2" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const v3 = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { cache }
    );
    expect(v3.body).toEqual({ 'og:title': 'Shared2' });
    expect(fetch).toHaveBeenCalledTimes(1);

    const fetch2 = vi.fn();
    vi.stubGlobal('fetch', fetch2);
    const v1 = await request(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { cache }
    );
    expect(v1.body).toEqual({ 'og:title': 'Shared2' });
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('v3 and v1 config agree on m.upload.size', async () => {
    const v3 = await request('/_matrix/media/v3/config');
    const v1 = await request('/_matrix/client/v1/media/config');
    expect(v3.body).toEqual(v1.body);
    expect(v3.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('v1 upload rejects oversized Content-Length like v3', async () => {
    const res = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_UPLOAD_SIZE + 1),
      },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ errcode: 'M_TOO_LARGE' });
  });

  it('v1 upload rejects unsupported MIME like v3', async () => {
    const res = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', 'Content-Length': '1' },
      body: bytesOf('x'),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('empty body upload succeeds with content_length 0', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' },
      body: new Uint8Array(),
    });
    expect(res.status).toBe(200);
    expect(res.db.rows[0].content_length).toBe(0);
  });

  it('download omits disposition for empty-string filename stored as empty', async () => {
    const mediaId = 'emptyfn';
    // empty string is truthy for disposition in some paths; product stores null when omitted.
    // When filename is '', safeContentDisposition still runs if truthy — verify null path remains omitted.
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, filename: null, content_type: 'image/png' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'x' } });
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/${mediaId}`, {}, { db, media });
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });
});

describe('media API TOKENMAXX edges after #109/#111 — Browser Rendering (v3 only)', () => {
  it('prefers BROWSER HTML when binding is configured', async () => {
    const url = 'https://spa2.example.org/';
    const browser = {
      fetch: vi.fn(
        async () =>
          new Response('<meta property="og:title" content="FromBrowser2" />', { status: 200 })
      ),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<title>Basic2</title>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.body).toEqual({ 'og:title': 'FromBrowser2' });
    expect(browser.fetch).toHaveBeenCalled();
  });

  it('falls back to basic HTML when BROWSER throws', async () => {
    const url = 'https://spa2.example.org/fallback';
    const browser = {
      fetch: vi.fn(async () => {
        throw new Error('browser down');
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<title>Fallback2</title>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.body).toEqual({ 'og:title': 'Fallback2' });
  });

  it('falls back when BROWSER returns non-ok', async () => {
    const url = 'https://spa2.example.org/busy';
    const browser = {
      fetch: vi.fn(async () => new Response('busy', { status: 503 })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="BasicOk2" />', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const res = await request(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      {},
      { browser }
    );
    expect(res.body).toEqual({ 'og:title': 'BasicOk2' });
  });
});
