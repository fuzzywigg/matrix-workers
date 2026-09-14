/**
 * TOKENMAXX HEAVY deepen after #106/#107 — different slice: media API routes.
 * Avoids oauth helpers (#106), push (#107), presence/account/devices (#100/#103/#105).
 * Helpers already covered in media-helpers.test.ts — this file focuses on HTTP routes.
 * Tests-only — no product inventing.
 * Exercises v3 + MSC3916 v1 upload/download/thumbnail/preview_url/config/create
 * via Hono app.request() with mocked R2, D1, CACHE, and fetch.
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

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: vi.fn(async (length: number = 24) => `mediaid${String(length).padStart(2, '0')}`),
  };
});

import mediaApp from '../src/api/media';
import { generateOpaqueId } from '../src/utils/ids';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const MEDIA_ID = 'mediaid24';
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

function createMediaDb(opts: { rows?: MediaRow[] } = {}) {
  const rows = opts.rows ? [...opts.rows] : [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    rows,
    inserts,
    updates,
    selects,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              const mediaId = args[0] as string;
              const row = rows.find((r) => r.media_id === mediaId);
              if (!row) return null;

              if (sql.includes('SELECT content_type, filename FROM media')) {
                return { content_type: row.content_type, filename: row.filename } as T;
              }
              if (sql.includes('SELECT content_type FROM media')) {
                return { content_type: row.content_type } as T;
              }
              if (sql.includes('SELECT user_id, content_length FROM media')) {
                return { user_id: row.user_id, content_length: row.content_length } as T;
              }
              return row as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },
            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              runs.push({ sql, args });

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
                } else {
                  // create placeholder: no filename column
                  const [mediaId, userId, createdAt] = args as [string, string, number];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: 'application/octet-stream',
                    content_length: 0,
                    filename: null,
                    created_at: createdAt,
                  });
                }
                return { meta: { changes: 1, last_row_id: rows.length }, success: true };
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
                  return { meta: { changes: 1, last_row_id: 0 }, success: true };
                }
                return { meta: { changes: 0, last_row_id: 0 }, success: true };
              }

              return { meta: { changes: 0, last_row_id: 0 }, success: true };
            },
          };
        },
      };
    },
  };

  return db;
}

type MediaDb = ReturnType<typeof createMediaDb>;

function createR2(seed: Record<string, R2ObjectLike> = {}) {
  const store = new Map<string, R2ObjectLike>(Object.entries(seed));
  const puts: Array<{ key: string; meta?: R2ObjectLike }> = [];

  return {
    store,
    puts,
    async get(key: string) {
      const obj = store.get(key);
      if (!obj) return null;
      const body =
        typeof obj.body === 'string'
          ? new TextEncoder().encode(obj.body)
          : obj.body instanceof ArrayBuffer
            ? new Uint8Array(obj.body)
            : obj.body;
      return {
        body,
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        async arrayBuffer() {
          if (body instanceof ReadableStream) {
            const reader = body.getReader();
            const chunks: Uint8Array[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const out = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              out.set(c, offset);
              offset += c.length;
            }
            return out.buffer;
          }
          if (body instanceof Uint8Array) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
          return body as ArrayBuffer;
        },
      };
    },
    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null,
      options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
    ) {
      let body: ArrayBuffer | Uint8Array | string;
      if (value == null) body = new Uint8Array();
      else if (typeof value === 'string') body = value;
      else if (value instanceof ArrayBuffer) body = value;
      else if (ArrayBuffer.isView(value)) body = value as Uint8Array;
      else body = new Uint8Array();
      const meta: R2ObjectLike = {
        body,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      };
      store.set(key, meta);
      puts.push({ key, meta });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async list() {
      return { objects: [...store.keys()].map((key) => ({ key })), truncated: false };
    },
  } as unknown as R2Bucket & {
    store: Map<string, R2ObjectLike>;
    puts: Array<{ key: string; meta?: R2ObjectLike }>;
  };
}

type MediaR2 = ReturnType<typeof createR2>;

function createCache(data: Record<string, string> = {}) {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const kv = {
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
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: typeof puts;
  };
}

type MediaCache = ReturnType<typeof createCache>;

function envFor(opts: {
  db?: MediaDb;
  media?: MediaR2;
  cache?: MediaCache;
  browser?: { fetch: (req: Request) => Promise<Response> } | null;
  serverName?: string;
} = {}): Env {
  return {
    SERVER_NAME: opts.serverName ?? SERVER,
    DB: (opts.db ?? createMediaDb()) as unknown as D1Database,
    MEDIA: opts.media ?? createR2(),
    CACHE: opts.cache ?? createCache(),
    ...(opts.browser !== undefined && opts.browser !== null ? { BROWSER: opts.browser } : {}),
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = envFor()
): Promise<{ status: number; body: any; headers: Headers; res: Response }> {
  const res = await mediaApp.request(`http://localhost${path}`, init, env);
  const headers = res.headers;
  const contentType = headers.get('Content-Type') || '';
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  let body: unknown = null;
  if (
    contentType.includes('application/json') ||
    contentType.includes('text/') ||
    !contentType ||
    contentType.includes('application/problem')
  ) {
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  } else {
    // Binary media: expose UTF-8 when printable (test fixtures use ASCII), else ArrayBuffer
    body = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? text : buf;
  }
  return { status: res.status, body, headers, res };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer test-token', ...extra };
}

function uploadInit(
  body: ArrayBuffer | Uint8Array | string,
  opts: { contentType?: string; filename?: string; contentLength?: string | null } = {}
): RequestInit {
  const headers: Record<string, string> = authHeaders({
    'Content-Type': opts.contentType ?? 'image/png',
  });
  if (opts.contentLength !== null) {
    const len =
      opts.contentLength ??
      String(typeof body === 'string' ? body.length : (body as ArrayBuffer | Uint8Array).byteLength);
    headers['Content-Length'] = len;
  }
  const qs = opts.filename ? `?filename=${encodeURIComponent(opts.filename)}` : '';
  void qs;
  return { method: 'POST', headers, body };
}

function seedRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    media_id: overrides.media_id ?? MEDIA_ID,
    user_id: overrides.user_id ?? USER,
    content_type: overrides.content_type ?? 'image/png',
    content_length: overrides.content_length ?? 4,
    filename: overrides.filename === undefined ? 'pic.png' : overrides.filename,
    created_at: overrides.created_at ?? 1_700_000_000_000,
  };
}

beforeEach(() => {
  vi.mocked(generateOpaqueId).mockReset();
  vi.mocked(generateOpaqueId).mockResolvedValue(MEDIA_ID);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /_matrix/media/v3/config (+ authenticated v1)
// ---------------------------------------------------------------------------

describe('media config routes', () => {
  it('returns m.upload.size on unauthenticated v3 config', async () => {
    const { status, body } = await request('/_matrix/media/v3/config');
    expect(status).toBe(200);
    expect(body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('returns m.upload.size on authenticated v1 config', async () => {
    const { status, body } = await request('/_matrix/client/v1/media/config', {
      headers: authHeaders(),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('reports exactly 50 MiB as the size limit', async () => {
    const { body } = await request('/_matrix/media/v3/config');
    expect(body['m.upload.size']).toBe(52_428_800);
  });
});

// ---------------------------------------------------------------------------
// POST /_matrix/media/v3/upload
// ---------------------------------------------------------------------------

describe('POST /_matrix/media/v3/upload', () => {
  it('uploads bytes, stores R2 + D1, returns mxc URI', async () => {
    const db = createMediaDb();
    const media = createR2();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { status, body } = await request(
      '/_matrix/media/v3/upload?filename=hello.png',
      uploadInit(bytes, { contentType: 'image/png', filename: 'hello.png' }),
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ content_uri: `mxc://${SERVER}/${MEDIA_ID}` });
    expect(generateOpaqueId).toHaveBeenCalledWith(24);
    expect(media.puts).toHaveLength(1);
    expect(media.puts[0].key).toBe(MEDIA_ID);
    expect(media.puts[0].meta?.customMetadata?.userId).toBe(USER);
    expect(media.puts[0].meta?.customMetadata?.filename).toBe('hello.png');
    expect(db.inserts).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      media_id: MEDIA_ID,
      user_id: USER,
      content_type: 'image/png',
      content_length: 4,
      filename: 'hello.png',
    });
  });

  it('defaults Content-Type to application/octet-stream when omitted', async () => {
    const db = createMediaDb();
    const media = createR2();
    const { status, body } = await request(
      '/_matrix/media/v3/upload',
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Length': '3' }),
        body: new Uint8Array([9, 9, 9]),
      },
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body.content_uri).toContain(MEDIA_ID);
    expect(db.rows[0].content_type).toBe('application/octet-stream');
  });

  it('rejects unsupported MIME types with M_FORBIDDEN', async () => {
    const { status, body } = await request(
      '/_matrix/media/v3/upload',
      uploadInit(new Uint8Array([1]), { contentType: 'application/x-msdownload' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(body.error).toContain('Unsupported content type');
    expect(body.error).toContain('application/x-msdownload');
  });

  it('strips MIME parameters before whitelist check and stores full header', async () => {
    const db = createMediaDb();
    const media = createR2();
    const { status } = await request(
      '/_matrix/media/v3/upload',
      uploadInit(new Uint8Array([1]), { contentType: 'text/plain; charset=utf-8' }),
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(db.rows[0].content_type).toBe('text/plain; charset=utf-8');
  });

  it('rejects Content-Length above MAX_UPLOAD_SIZE before reading body', async () => {
    const db = createMediaDb();
    const media = createR2();
    const { status, body } = await request(
      '/_matrix/media/v3/upload',
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'image/png',
          'Content-Length': String(MAX_UPLOAD_SIZE + 1),
        }),
        body: new Uint8Array([1]),
      },
      envFor({ db, media })
    );
    expect(status).toBe(413);
    expect(body.errcode).toBe('M_TOO_LARGE');
    expect(media.puts).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('rejects actual body larger than MAX_UPLOAD_SIZE even if Content-Length lies', async () => {
    const db = createMediaDb();
    const media = createR2();
    const big = new Uint8Array(MAX_UPLOAD_SIZE + 1);
    const { status, body } = await request(
      '/_matrix/media/v3/upload',
      {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'image/png',
          'Content-Length': '1',
        }),
        body: big,
      },
      envFor({ db, media })
    );
    expect(status).toBe(413);
    expect(body.errcode).toBe('M_TOO_LARGE');
    expect(media.puts).toHaveLength(0);
  });

  it('sanitizes unsafe filenames for R2 customMetadata and D1', async () => {
    const db = createMediaDb();
    const media = createR2();
    const { status } = await request(
      '/_matrix/media/v3/upload?filename=' + encodeURIComponent('../../evil\r\nX.png'),
      uploadInit(new Uint8Array([1]), {
        contentType: 'image/png',
        filename: '../../evil\r\nX.png',
      }),
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(media.puts[0].meta?.customMetadata?.filename).toBe('.._.._evil__X.png');
    expect(db.rows[0].filename).toBe('.._.._evil__X.png');
  });

  it('stores null filename when query param omitted', async () => {
    const db = createMediaDb();
    const media = createR2();
    await request(
      '/_matrix/media/v3/upload',
      uploadInit(new Uint8Array([1])),
      envFor({ db, media })
    );
    expect(db.rows[0].filename).toBeNull();
    expect(media.puts[0].meta?.customMetadata?.filename).toBe('');
  });

  it('accepts PDF and JSON whitelist MIME types', async () => {
    for (const contentType of ['application/pdf', 'application/json']) {
      vi.mocked(generateOpaqueId).mockResolvedValueOnce(`id-${contentType}`);
      const db = createMediaDb();
      const media = createR2();
      const { status, body } = await request(
        '/_matrix/media/v3/upload',
        uploadInit(new Uint8Array([1]), { contentType }),
        envFor({ db, media })
      );
      expect(status).toBe(200);
      expect(body.content_uri).toContain(`id-${contentType}`);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/media/v3/download
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/download', () => {
  it('serves local media with type, disposition, cache, and security headers', async () => {
    const db = createMediaDb({ rows: [seedRow({ filename: 'pic.png' })] });
    const media = createR2({ [MEDIA_ID]: { body: 'PNGDATA' } });
    const { status, body, headers } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toBe('PNGDATA');
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.get('Content-Disposition')).toBe('inline; filename="pic.png"');
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('omits Content-Disposition when D1 filename is null', async () => {
    const db = createMediaDb({ rows: [seedRow({ filename: null })] });
    const media = createR2({ [MEDIA_ID]: { body: 'X' } });
    const { headers } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media })
    );
    expect(headers.get('Content-Disposition')).toBeNull();
  });

  it('defaults Content-Type when D1 row missing but R2 object exists', async () => {
    const db = createMediaDb({ rows: [] });
    const media = createR2({ [MEDIA_ID]: { body: 'orphan' } });
    const { status, headers } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('returns M_NOT_FOUND for remote serverName', async () => {
    const { status, body } = await request(`/_matrix/media/v3/download/${REMOTE}/${MEDIA_ID}`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
    expect(body.error).toContain('Remote media');
  });

  it('returns M_NOT_FOUND when R2 object missing', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const { status, body } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media: createR2() })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('sanitizes requested filename on download-with-filename route', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'X' } });
    const unsafe = encodeURIComponent('a/../b\n.png');
    const { status, headers } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}/${unsafe}`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Disposition')).toBe('inline; filename="a_.._b_.png"');
  });

  it('rejects remote server on download-with-filename', async () => {
    const { status, body } = await request(
      `/_matrix/media/v3/download/${REMOTE}/${MEDIA_ID}/name.png`
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns 404 when R2 missing on download-with-filename', async () => {
    const { status, body } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}/name.png`,
      {},
      envFor({ db: createMediaDb({ rows: [seedRow()] }) })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/media/v3/thumbnail
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/thumbnail', () => {
  it('rejects remote serverName', async () => {
    const { status, body } = await request(
      `/_matrix/media/v3/thumbnail/${REMOTE}/${MEDIA_ID}?width=64&height=64`
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns 404 when media metadata missing in D1', async () => {
    const { status, body } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}?width=32&height=32`,
      {},
      envFor({ db: createMediaDb() })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns cached pre-generated thumbnail when present in R2', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const thumbKey = `thumb_${MEDIA_ID}_64x64_scale`;
    const media = createR2({
      [MEDIA_ID]: { body: 'ORIG' },
      [thumbKey]: { body: 'THUMBJPEG' },
    });
    const { status, body, headers } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}?width=64&height=64&method=scale`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toBe('THUMBJPEG');
    expect(headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('returns original for non-image content without calling fetch resize', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const db = createMediaDb({ rows: [seedRow({ content_type: 'application/pdf' })] });
    const media = createR2({ [MEDIA_ID]: { body: '%PDF' } });
    const { status, body, headers } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}?width=32&height=32`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toBe('%PDF');
    expect(headers.get('Content-Type')).toBe('application/pdf');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('generates thumbnail via cf.image fetch and caches to R2', async () => {
    const thumbBytes = new Uint8Array([0xff, 0xd8, 0xff]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(thumbBytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
    );
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'ORIGPNG' } });
    const { status, headers } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}?width=96&height=96&method=crop`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Type')).toBe('image/jpeg');
    expect(headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(`thumb_${MEDIA_ID}_96x96_crop`)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      `https://${SERVER}/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}`,
      expect.objectContaining({
        cf: expect.objectContaining({
          image: expect.objectContaining({ fit: 'cover', width: 96, height: 96, format: 'jpeg' }),
        }),
      })
    );
  });

  it('falls back to original with X-Thumbnail-Generated false when resize throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('resize unavailable');
      })
    );
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'ORIG' } });
    const { status, body, headers } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}?width=48&height=48`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toBe('ORIG');
    expect(headers.get('X-Thumbnail-Generated')).toBe('false');
    expect(headers.get('Content-Type')).toBe('image/png');
  });

  it('falls back when resize returns non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'ORIG' } });
    const { status, headers } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(headers.get('X-Thumbnail-Generated')).toBe('false');
  });

  it('returns 404 when original missing after metadata hit and no cached thumb', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const { status, body } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media: createR2() })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('clamps oversized width/height query params before cache key lookup', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const thumbKey = `thumb_${MEDIA_ID}_1920x1920_scale`;
    const media = createR2({
      [MEDIA_ID]: { body: 'ORIG' },
      [thumbKey]: { body: 'CLAMPED' },
    });
    const { body } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}?width=99999&height=99999`,
      {},
      envFor({ db, media })
    );
    expect(body).toBe('CLAMPED');
  });

  it('defaults missing width/height to 96 in the thumbnail key', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const thumbKey = `thumb_${MEDIA_ID}_96x96_scale`;
    const media = createR2({
      [MEDIA_ID]: { body: 'ORIG' },
      [thumbKey]: { body: 'DEFAULT' },
    });
    const { body } = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${MEDIA_ID}`,
      {},
      envFor({ db, media })
    );
    expect(body).toBe('DEFAULT');
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/media/v3/preview_url
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/preview_url', () => {
  it('requires url query param', async () => {
    const { status, body } = await request('/_matrix/media/v3/preview_url', {
      headers: authHeaders(),
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
    expect(body.error).toContain('url');
  });

  it('rejects SSRF / localhost URLs with M_UNKNOWN 400', async () => {
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('http://127.0.0.1/'),
      { headers: authHeaders() }
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('rejects non-http schemes', async () => {
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('file:///etc/passwd'),
      { headers: authHeaders() }
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('returns cached preview without fetching', async () => {
    const cache = createCache({
      'preview:https://example.org/a': JSON.stringify({ 'og:title': 'Cached' }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.org/a'),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ 'og:title': 'Cached' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns image og fields for image Content-Type and caches them', async () => {
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
    );
    const url = 'https://cdn.example.org/photo.jpg';
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ 'og:image': url, 'og:image:type': 'image/jpeg' });
    expect(cache.puts[0].key).toBe(`preview:${url}`);
    expect(cache.puts[0].options?.expirationTtl).toBe(3600);
  });

  it('returns empty object for non-HTML non-image responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    );
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://api.example.org/x'),
      { headers: authHeaders() },
      envFor()
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('returns empty object when upstream is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const { body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.org/missing'),
      { headers: authHeaders() },
      envFor()
    );
    expect(body).toEqual({});
  });

  it('parses HTML Open Graph tags and caches non-empty preview', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Hello &amp; World" />
        <meta property="og:image" content="/img.png" />
        <meta property="og:description" content="Desc" />
      </head></html>
    `;
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    );
    const url = 'https://blog.example.org/post';
    const { body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url) + '&ts=123',
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(body['og:title']).toBe('Hello & World');
    expect(body['og:image']).toBe('https://blog.example.org/img.png');
    expect(body['og:description']).toBe('Desc');
    expect(cache.puts).toHaveLength(1);
  });

  it('does not cache empty HTML previews', async () => {
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const { body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://empty.example.org/'),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(body).toEqual({});
    expect(cache.puts).toHaveLength(0);
  });

  it('uses Browser Rendering when BROWSER binding is available', async () => {
    const browserHtml = `<meta property="og:title" content="FromBrowser" />`;
    const browser = {
      fetch: vi.fn(async () => new Response(browserHtml, { status: 200 })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<title>Basic</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const { body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://spa.example.org/'),
      { headers: authHeaders() },
      envFor({ browser })
    );
    expect(body['og:title']).toBe('FromBrowser');
    expect(browser.fetch).toHaveBeenCalled();
  });

  it('falls back to basic fetch HTML when Browser Rendering fails', async () => {
    const browser = {
      fetch: vi.fn(async () => {
        throw new Error('browser down');
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<title>FallbackTitle</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );
    const { body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://spa.example.org/'),
      { headers: authHeaders() },
      envFor({ browser })
    );
    expect(body['og:title']).toBe('FallbackTitle');
  });

  it('falls back to basic fetch when Browser Rendering returns non-ok', async () => {
    const browser = {
      fetch: vi.fn(async () => new Response('busy', { status: 503 })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<meta property="og:title" content="BasicOk" />', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );
    const { body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://spa.example.org/'),
      { headers: authHeaders() },
      envFor({ browser })
    );
    expect(body['og:title']).toBe('BasicOk');
  });

  it('returns empty object when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      })
    );
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.org/x'),
      { headers: authHeaders() },
      envFor()
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// MSC3916 authenticated media — upload / create / upload-to-placeholder
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v1/media/upload', () => {
  it('mirrors v3 upload success path', async () => {
    const db = createMediaDb();
    const media = createR2();
    const { status, body } = await request(
      '/_matrix/client/v1/media/upload?filename=a.png',
      uploadInit(new Uint8Array([5, 6]), { contentType: 'image/png' }),
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ content_uri: `mxc://${SERVER}/${MEDIA_ID}` });
    expect(db.rows[0].content_length).toBe(2);
  });

  it('rejects unsupported MIME on v1 upload', async () => {
    const { status, body } = await request(
      '/_matrix/client/v1/media/upload',
      uploadInit(new Uint8Array([1]), { contentType: 'text/html' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('rejects oversized Content-Length on v1 upload', async () => {
    const { status, body } = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_UPLOAD_SIZE + 10),
      }),
      body: new Uint8Array([1]),
    });
    expect(status).toBe(413);
    expect(body.errcode).toBe('M_TOO_LARGE');
  });

  it('rejects oversized body on v1 upload when Content-Length is understated', async () => {
    const { status, body } = await request('/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'image/png',
        'Content-Length': '1',
      }),
      body: new Uint8Array(MAX_UPLOAD_SIZE + 1),
    });
    expect(status).toBe(413);
    expect(body.errcode).toBe('M_TOO_LARGE');
  });
});

describe('POST /_matrix/client/v1/media/create', () => {
  it('creates a zero-length placeholder and returns unused_expires_at', async () => {
    const db = createMediaDb();
    const before = Date.now();
    const { status, body } = await request(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: authHeaders() },
      envFor({ db })
    );
    const after = Date.now();
    expect(status).toBe(200);
    expect(body.content_uri).toBe(`mxc://${SERVER}/${MEDIA_ID}`);
    expect(body.unused_expires_at).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(body.unused_expires_at).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
    expect(db.rows[0]).toMatchObject({
      media_id: MEDIA_ID,
      user_id: USER,
      content_type: 'application/octet-stream',
      content_length: 0,
      filename: null,
    });
  });
});

describe('PUT /_matrix/client/v1/media/upload/:serverName/:mediaId', () => {
  it('forbids upload to a remote serverName', async () => {
    const { status, body } = await request(`/_matrix/client/v1/media/upload/${REMOTE}/${MEDIA_ID}`, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'image/png' }),
      body: new Uint8Array([1]),
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(body.error).toContain('remote');
  });

  it('returns 404 when placeholder does not exist', async () => {
    const { status, body } = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([1]),
      },
      envFor({ db: createMediaDb() })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('forbids upload when placeholder belongs to another user', async () => {
    const db = createMediaDb({
      rows: [seedRow({ user_id: BOB, content_length: 0, filename: null })],
    });
    const { status, body } = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([1]),
      },
      envFor({ db })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(body.error).toContain('Not authorized');
  });

  it('returns M_CANNOT_OVERWRITE_MEDIA when content_length already > 0', async () => {
    const db = createMediaDb({ rows: [seedRow({ content_length: 10 })] });
    const { status, body } = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([1]),
      },
      envFor({ db })
    );
    expect(status).toBe(409);
    expect(body.errcode).toBe('M_CANNOT_OVERWRITE_MEDIA');
  });

  it('writes bytes to placeholder and updates D1 metadata', async () => {
    const db = createMediaDb({
      rows: [seedRow({ content_length: 0, content_type: 'application/octet-stream', filename: null })],
    });
    const media = createR2();
    const { status, body } = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}?filename=final.png`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([7, 8, 9]),
      },
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(media.puts[0].key).toBe(MEDIA_ID);
    expect(media.puts[0].meta?.customMetadata?.filename).toBe('final.png');
    expect(db.rows[0]).toMatchObject({
      content_type: 'image/png',
      content_length: 3,
      filename: 'final.png',
    });
  });

  it('stores empty filename customMetadata when query filename omitted', async () => {
    const db = createMediaDb({
      rows: [seedRow({ content_length: 0, filename: null })],
    });
    const media = createR2();
    await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/jpeg' }),
        body: new Uint8Array([1]),
      },
      envFor({ db, media })
    );
    expect(media.puts[0].meta?.customMetadata?.filename).toBe('');
    expect(db.rows[0].filename).toBeNull();
    expect(db.rows[0].content_type).toBe('image/jpeg');
  });
});

// ---------------------------------------------------------------------------
// MSC3916 authenticated download / thumbnail / preview / config
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v1/media/download', () => {
  it('serves authenticated download with security headers', async () => {
    const db = createMediaDb({ rows: [seedRow({ filename: 'a.png' })] });
    const media = createR2({ [MEDIA_ID]: { body: 'DATA' } });
    const { status, body, headers } = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(status).toBe(200);
    expect(body).toBe('DATA');
    expect(headers.get('Content-Disposition')).toBe('inline; filename="a.png"');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects remote server on v1 download', async () => {
    const { status, body } = await request(`/_matrix/client/v1/media/download/${REMOTE}/${MEDIA_ID}`, {
      headers: authHeaders(),
    });
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns 404 when R2 object missing on v1 download', async () => {
    const { status, body } = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db: createMediaDb({ rows: [seedRow()] }), media: createR2() })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('omits disposition when filename null on v1 download', async () => {
    const db = createMediaDb({ rows: [seedRow({ filename: null })] });
    const media = createR2({ [MEDIA_ID]: { body: 'X' } });
    const { headers } = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(headers.get('Content-Disposition')).toBeNull();
  });

  it('sanitizes filename on v1 download-with-filename', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'X' } });
    const { headers } = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${MEDIA_ID}/${encodeURIComponent('hi world.png')}`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(headers.get('Content-Disposition')).toBe('inline; filename="hi_world.png"');
  });

  it('rejects remote on v1 download-with-filename', async () => {
    const { status, body } = await request(
      `/_matrix/client/v1/media/download/${REMOTE}/${MEDIA_ID}/x.png`,
      { headers: authHeaders() }
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns 404 when R2 missing on v1 download-with-filename', async () => {
    const { status, body } = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${MEDIA_ID}/x.png`,
      { headers: authHeaders() },
      envFor({ db: createMediaDb({ rows: [seedRow()] }) })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
});

describe('GET /_matrix/client/v1/media/thumbnail', () => {
  it('rejects remote serverName', async () => {
    const { status, body } = await request(
      `/_matrix/client/v1/media/thumbnail/${REMOTE}/${MEDIA_ID}`,
      { headers: authHeaders() }
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns 404 when metadata missing', async () => {
    const { status, body } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor()
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('serves cached thumbnail key', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const key = `thumb_${MEDIA_ID}_32x32_scale`;
    const media = createR2({ [MEDIA_ID]: { body: 'O' }, [key]: { body: 'T' } });
    const { body, headers } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}?width=32&height=32`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(body).toBe('T');
    expect(headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('resizes images and sets X-Thumbnail-Generated true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200 }))
    );
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'ORIG' } });
    const { headers } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}?width=10&height=10&method=crop`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(media.store.has(`thumb_${MEDIA_ID}_10x10_crop`)).toBe(true);
  });

  it('falls back for images when resize fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no cf image');
      })
    );
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'ORIG' } });
    const { body, headers } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(body).toBe('ORIG');
    expect(headers.get('X-Thumbnail-Generated')).toBe('false');
  });

  it('returns original for non-image without X-Thumbnail-Generated header', async () => {
    const db = createMediaDb({ rows: [seedRow({ content_type: 'audio/ogg' })] });
    const media = createR2({ [MEDIA_ID]: { body: 'OGG' } });
    const { body, headers } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(body).toBe('OGG');
    expect(headers.get('Content-Type')).toBe('audio/ogg');
    expect(headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('returns 404 when original missing after metadata hit', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const { status, body } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db, media: createR2() })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('falls back when resize returns non-ok on v1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'ORIG' } });
    const { headers } = await request(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db, media })
    );
    expect(headers.get('X-Thumbnail-Generated')).toBe('false');
  });
});

describe('GET /_matrix/client/v1/media/preview_url', () => {
  it('requires url query param', async () => {
    const { status, body } = await request('/_matrix/client/v1/media/preview_url', {
      headers: authHeaders(),
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects SSRF targets', async () => {
    const { status, body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('http://192.168.0.1/'),
      { headers: authHeaders() }
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('returns cache hit without fetch', async () => {
    const cache = createCache({
      'preview:https://ok.example.org/': JSON.stringify({ 'og:title': 'Hit' }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('https://ok.example.org/'),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(body).toEqual({ 'og:title': 'Hit' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caches image preview results', async () => {
    const cache = createCache();
    const url = 'https://img.example.org/a.png';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } }))
    );
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent(url),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(body['og:image']).toBe(url);
    expect(cache.puts[0].options?.expirationTtl).toBe(3600);
  });

  it('returns empty for non-html content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 200, headers: { 'Content-Type': 'text/plain' } }))
    );
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('https://example.org/t'),
      { headers: authHeaders() },
      envFor()
    );
    expect(body).toEqual({});
  });

  it('returns empty when upstream not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('https://example.org/t'),
      { headers: authHeaders() },
      envFor()
    );
    expect(body).toEqual({});
  });

  it('parses HTML and caches OG fields (no BROWSER on v1 path)', async () => {
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<meta property="og:title" content="V1Title" />', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('https://example.org/p'),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(body['og:title']).toBe('V1Title');
    expect(cache.puts).toHaveLength(1);
  });

  it('does not cache empty HTML preview on v1', async () => {
    const cache = createCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html/>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    );
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('https://example.org/e'),
      { headers: authHeaders() },
      envFor({ cache })
    );
    expect(body).toEqual({});
    expect(cache.puts).toHaveLength(0);
  });

  it('returns empty object when fetch throws on v1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    const { body } = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('https://example.org/x'),
      { headers: authHeaders() },
      envFor()
    );
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration leftovers — create → upload → download round-trip
// ---------------------------------------------------------------------------

describe('media API TOKENMAXX integration leftovers after #106/#107', () => {
  it('create placeholder → PUT upload → v3 download round-trip', async () => {
    const db = createMediaDb();
    const media = createR2();
    const env = envFor({ db, media });

    const created = await request(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: authHeaders() },
      env
    );
    expect(created.status).toBe(200);
    const mediaId = String(created.body.content_uri).split('/').pop();

    const put = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}?filename=round.png`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([10, 20, 30]),
      },
      env
    );
    expect(put.status).toBe(200);

    const dl = await request(`/_matrix/media/v3/download/${SERVER}/${mediaId}`, {}, env);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Type')).toBe('image/png');
    expect(dl.headers.get('Content-Disposition')).toBe('inline; filename="round.png"');
    const bytes =
      typeof dl.body === 'string'
        ? new TextEncoder().encode(dl.body)
        : new Uint8Array(dl.body as ArrayBuffer);
    expect(Array.from(bytes)).toEqual([10, 20, 30]);
  });

  it('v3 upload then authenticated v1 download with matching security headers', async () => {
    const db = createMediaDb();
    const media = createR2();
    const env = envFor({ db, media });
    const up = await request(
      '/_matrix/media/v3/upload?filename=sec.png',
      uploadInit(new Uint8Array([1, 2]), { contentType: 'image/png' }),
      env
    );
    expect(up.status).toBe(200);
    const id = String(up.body.content_uri).split('/').pop();
    const dl = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${id}`,
      { headers: authHeaders() },
      env
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get('X-Frame-Options')).toBe('DENY');
    expect(dl.headers.get('Cache-Control')).toContain('immutable');
  });

  it('v1 upload then v3 thumbnail cache miss → resize → subsequent cache hit', async () => {
    const db = createMediaDb();
    const media = createR2();
    const env = envFor({ db, media });
    vi.mocked(generateOpaqueId).mockResolvedValue('thumbflow24');

    const up = await request(
      '/_matrix/client/v1/media/upload',
      uploadInit(new Uint8Array([9]), { contentType: 'image/jpeg' }),
      env
    );
    const id = String(up.body.content_uri).split('/').pop()!;

    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCount += 1;
        return new Response(new Uint8Array([0xff, 0xd8]), { status: 200 });
      })
    );

    const first = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${id}?width=40&height=40`,
      {},
      env
    );
    expect(first.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(fetchCount).toBe(1);

    const second = await request(
      `/_matrix/media/v3/thumbnail/${SERVER}/${id}?width=40&height=40`,
      {},
      env
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('Content-Type')).toBe('image/jpeg');
    expect(fetchCount).toBe(1); // cache hit — no second resize
  });

  it('preview_url cache is shared between v3 and v1 routes', async () => {
    const cache = createCache();
    const env = envFor({ cache });
    const url = 'https://shared.example.org/page';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<meta property="og:title" content="Shared" />', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );

    const v3 = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url),
      { headers: authHeaders() },
      env
    );
    expect(v3.body['og:title']).toBe('Shared');
    expect(fetch).toHaveBeenCalledTimes(1);

    const v1 = await request(
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent(url),
      { headers: authHeaders() },
      env
    );
    expect(v1.body['og:title']).toBe('Shared');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects overwrite after successful placeholder fill', async () => {
    const db = createMediaDb();
    const media = createR2();
    const env = envFor({ db, media });
    await request('/_matrix/client/v1/media/create', { method: 'POST', headers: authHeaders() }, env);
    await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([1]),
      },
      env
    );
    const again = await request(
      `/_matrix/client/v1/media/upload/${SERVER}/${MEDIA_ID}`,
      {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'image/png' }),
        body: new Uint8Array([2]),
      },
      env
    );
    expect(again.status).toBe(409);
    expect(again.body.errcode).toBe('M_CANNOT_OVERWRITE_MEDIA');
  });
});

// ---------------------------------------------------------------------------
// Extra edge matrix — MIME whitelist / server name / disposition
// ---------------------------------------------------------------------------

describe('media route edge matrix', () => {
  it.each([
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'audio/mp3',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'text/plain',
  ])('accepts whitelist MIME %s on v3 upload', async (contentType) => {
    vi.mocked(generateOpaqueId).mockResolvedValueOnce(`mime-${contentType.replace(/[/:]/g, '_')}`);
    const db = createMediaDb();
    const media = createR2();
    const { status } = await request(
      '/_matrix/media/v3/upload',
      uploadInit(new Uint8Array([1]), { contentType }),
      envFor({ db, media })
    );
    expect(status).toBe(200);
  });

  it.each(['text/html', 'application/javascript', 'image/tiff', 'multipart/form-data'])(
    'rejects non-whitelist MIME %s',
    async (contentType) => {
      const { status, body } = await request(
        '/_matrix/media/v3/upload',
        uploadInit(new Uint8Array([1]), { contentType })
      );
      expect(status).toBe(403);
      expect(body.errcode).toBe('M_FORBIDDEN');
    }
  );

  it('treats SERVER_NAME comparison as exact string match', async () => {
    const db = createMediaDb({ rows: [seedRow()] });
    const media = createR2({ [MEDIA_ID]: { body: 'X' } });
    const { status } = await request(
      `/_matrix/media/v3/download/Example.Com/${MEDIA_ID}`,
      {},
      envFor({ db, media, serverName: 'example.com' })
    );
    expect(status).toBe(404);
  });

  it('allows unusual ports rejected by preview validator', async () => {
    const { status, body } = await request(
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.org:9000/'),
      { headers: authHeaders() }
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('v3 download-with-filename defaults content-type when D1 row missing', async () => {
    const media = createR2({ [MEDIA_ID]: { body: 'Y' } });
    const { headers, status } = await request(
      `/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}/f.bin`,
      {},
      envFor({ db: createMediaDb(), media })
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('v1 download defaults content-type when D1 row missing', async () => {
    const media = createR2({ [MEDIA_ID]: { body: 'Y' } });
    const { headers, status } = await request(
      `/_matrix/client/v1/media/download/${SERVER}/${MEDIA_ID}`,
      { headers: authHeaders() },
      envFor({ db: createMediaDb(), media })
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });
});
