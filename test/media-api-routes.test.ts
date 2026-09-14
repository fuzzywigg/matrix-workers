/**
 * TOKENMAXX HEAVY deepen after #106/#107 — different slice: media API routes.
 * Avoids push (#107/#108), oauth (#106), presence/report/receipts/typing/to-device/
 * account-data (#105), account (#103), admin (#102), login (#101), devices/aliases/
 * relations/tags/profile (#100), keys (#99), key-backups (#96).
 * Helper sanitize/OG/MIME coverage lives in media-helpers.test.ts.
 * Tests-only — no product inventing.
 * Exercises v3 + MSC3916 upload/download/thumbnail/preview_url/config via Hono app.request().
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
    generateOpaqueId: vi.fn(async () => {
      opaqueSeq += 1;
      return `mediaid${opaqueSeq}`;
    }),
  };
});

import mediaApp from '../src/api/media';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const MAX_UPLOAD = 50 * 1024 * 1024;

type MediaRow = {
  media_id: string;
  user_id: string;
  content_type: string;
  content_length: number;
  filename: string | null;
  created_at: number;
};

type R2Object = {
  body: ReadableStream | ArrayBuffer | Uint8Array;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

type SqlCall = { sql: string; args: unknown[] };
type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type R2Put = {
  key: string;
  body: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null;
  options?: R2PutOptions;
};

function createMediaDb(opts: { rows?: MediaRow[]; throwOn?: string } = {}) {
  const rows = opts.rows ? [...opts.rows] : [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    rows,
    inserts,
    updates,
    selects,
    prepare(sql: string) {
      if (opts.throwOn && sql.includes(opts.throwOn)) {
        throw new Error(`forced db error: ${opts.throwOn}`);
      }
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('SELECT content_type, filename FROM media WHERE media_id = ?')
              ) {
                const mediaId = args[0] as string;
                const hit = rows.find((r) => r.media_id === mediaId);
                if (!hit) return null;
                return {
                  content_type: hit.content_type,
                  filename: hit.filename,
                } as T;
              }

              if (sql.includes('SELECT content_type FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const hit = rows.find((r) => r.media_id === mediaId);
                if (!hit) return null;
                return { content_type: hit.content_type } as T;
              }

              if (sql.includes('SELECT user_id, content_length FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const hit = rows.find((r) => r.media_id === mediaId);
                if (!hit) return null;
                return {
                  user_id: hit.user_id,
                  content_length: hit.content_length,
                } as T;
              }

              return null;
            },

            async run() {
              if (sql.includes('INSERT INTO media')) {
                inserts.push({ sql, args });
                if (sql.includes('filename, created_at')) {
                  const [mediaId, userId, contentType, contentLength, filename, createdAt] =
                    args as [string, string, string, number, string | null, number];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: contentType,
                    content_length: contentLength,
                    filename,
                    created_at: createdAt,
                  });
                } else {
                  // create placeholder: media_id, user_id, created_at
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
                const hit = rows.find((r) => r.media_id === mediaId);
                if (hit) {
                  hit.content_type = contentType;
                  hit.content_length = contentLength;
                  hit.filename = filename;
                }
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              throw new Error(`Unhandled SQL run in test stub: ${sql.slice(0, 120)}`);
            },

            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };

  return db;
}

function mockR2(seed: Record<string, R2Object> = {}) {
  const objects = new Map<string, R2Object>(Object.entries(seed));
  const puts: R2Put[] = [];
  const gets: string[] = [];

  const bucket = {
    objects,
    puts,
    gets,
    async get(key: string) {
      gets.push(key);
      const obj = objects.get(key);
      if (!obj) return null;
      const bodyBytes =
        obj.body instanceof ArrayBuffer
          ? new Uint8Array(obj.body)
          : obj.body instanceof Uint8Array
            ? obj.body
            : new Uint8Array(await new Response(obj.body as BodyInit).arrayBuffer());
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bodyBytes);
            controller.close();
          },
        }),
        arrayBuffer: async () => bodyBytes.buffer.slice(
          bodyBytes.byteOffset,
          bodyBytes.byteOffset + bodyBytes.byteLength
        ),
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
      };
    },
    async put(
      key: string,
      body: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null,
      options?: R2PutOptions
    ) {
      puts.push({ key, body, options });
      let stored: ArrayBuffer | Uint8Array;
      if (body == null) {
        stored = new Uint8Array();
      } else if (typeof body === 'string') {
        stored = new TextEncoder().encode(body);
      } else if (body instanceof ArrayBuffer) {
        stored = body;
      } else if (ArrayBuffer.isView(body)) {
        stored = body as ArrayBufferView as Uint8Array;
      } else if (body instanceof Blob) {
        stored = new Uint8Array(await body.arrayBuffer());
      } else {
        stored = new Uint8Array(await new Response(body).arrayBuffer());
      }
      objects.set(key, {
        body: stored,
        httpMetadata: options?.httpMetadata as { contentType?: string } | undefined,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      });
      return undefined;
    },
    async head() {
      return null;
    },
    async delete() {
      return undefined;
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };

  return bucket as unknown as R2Bucket & {
    objects: Map<string, R2Object>;
    puts: R2Put[];
    gets: string[];
  };
}

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    data,
    puts,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
  };
}

type MediaDb = ReturnType<typeof createMediaDb>;
type MediaR2 = ReturnType<typeof mockR2>;
type MediaKv = ReturnType<typeof mockKv>;

type Harness = {
  db: MediaDb;
  media: MediaR2;
  cache: MediaKv;
  browser?: { fetch: (req: Request) => Promise<Response> };
};

function envFor(h: Harness): Env {
  const env: Record<string, unknown> = {
    DB: h.db,
    MEDIA: h.media,
    CACHE: h.cache,
    SERVER_NAME: SERVER,
  };
  if (h.browser) env.BROWSER = h.browser;
  return env as unknown as Env;
}

async function request(
  h: Harness,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; headers: Headers; res: Response }> {
  const res = await mediaApp.request(`http://localhost${path}`, init, envFor(h));
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, res };
}

function harness(opts: {
  rows?: MediaRow[];
  r2?: Record<string, R2Object>;
  cache?: Record<string, string>;
  browser?: Harness['browser'];
  throwOn?: string;
} = {}): Harness {
  return {
    db: createMediaDb({ rows: opts.rows, throwOn: opts.throwOn }),
    media: mockR2(opts.r2),
    cache: mockKv(opts.cache),
    browser: opts.browser,
  };
}

function seedRow(partial: Partial<MediaRow> & Pick<MediaRow, 'media_id'>): MediaRow {
  return {
    media_id: partial.media_id,
    user_id: partial.user_id ?? USER,
    content_type: partial.content_type ?? 'image/png',
    content_length: partial.content_length ?? 4,
    filename: partial.filename ?? null,
    created_at: partial.created_at ?? 1_700_000_000_000,
  };
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function uploadInit(
  body: BodyInit,
  opts: { contentType?: string; contentLength?: string | number } = {}
): RequestInit {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-token',
    'Content-Type': opts.contentType ?? 'image/png',
  };
  if (opts.contentLength !== undefined) {
    headers['Content-Length'] = String(opts.contentLength);
  }
  return { method: 'POST', headers, body };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  opaqueSeq = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/config', () => {
  it('returns upload size without auth', async () => {
    const h = harness();
    const { status, body } = await request(h, '/_matrix/media/v3/config');
    expect(status).toBe(200);
    expect(body).toEqual({ 'm.upload.size': MAX_UPLOAD });
  });
});

describe('GET /_matrix/client/v1/media/config', () => {
  it('returns upload size (auth mocked)', async () => {
    const h = harness();
    const { status, body } = await request(h, '/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ 'm.upload.size': MAX_UPLOAD });
  });
});

// ---------------------------------------------------------------------------
// v3 upload
// ---------------------------------------------------------------------------

describe('POST /_matrix/media/v3/upload', () => {
  it('uploads bytes, stores R2+D1, returns mxc URI', async () => {
    const h = harness();
    const payload = bytes('PNGDATA');
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/upload?filename=photo.png',
      uploadInit(payload, { contentType: 'image/png' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ content_uri: `mxc://${SERVER}/mediaid1` });
    expect(h.media.puts).toHaveLength(1);
    expect(h.media.puts[0].key).toBe('mediaid1');
    expect(h.media.puts[0].options?.httpMetadata).toEqual({ contentType: 'image/png' });
    expect(h.media.puts[0].options?.customMetadata).toMatchObject({
      userId: USER,
      filename: 'photo.png',
    });
    expect(h.db.inserts).toHaveLength(1);
    expect(h.db.rows[0]).toMatchObject({
      media_id: 'mediaid1',
      user_id: USER,
      content_type: 'image/png',
      content_length: payload.byteLength,
      filename: 'photo.png',
    });
  });

  it('defaults content-type to octet-stream and null filename', async () => {
    const h = harness();
    const { status, body } = await request(h, '/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: bytes('x'),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ content_uri: `mxc://${SERVER}/mediaid1` });
    expect(h.db.rows[0].content_type).toBe('application/octet-stream');
    expect(h.db.rows[0].filename).toBeNull();
    expect(h.media.puts[0].options?.customMetadata?.filename).toBe('');
  });

  it('sanitizes dangerous filenames before storage', async () => {
    const h = harness();
    await request(
      h,
      '/_matrix/media/v3/upload?filename=' + encodeURIComponent('../evil\r\nX:1.png'),
      uploadInit(bytes('x'), { contentType: 'image/png' })
    );
    expect(h.db.rows[0].filename).toBe('.._evil__X_1.png');
    expect(h.media.puts[0].options?.customMetadata?.filename).toBe('.._evil__X_1.png');
  });

  it('rejects unsupported MIME types with M_FORBIDDEN', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/upload',
      uploadInit(bytes('x'), { contentType: 'text/html' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: expect.stringContaining('Unsupported content type: text/html'),
    });
    expect(h.media.puts).toHaveLength(0);
    expect(h.db.inserts).toHaveLength(0);
  });

  it('strips MIME parameters when validating whitelist', async () => {
    const h = harness();
    const { status } = await request(
      h,
      '/_matrix/media/v3/upload',
      uploadInit(bytes('x'), { contentType: 'image/jpeg; charset=binary' })
    );
    expect(status).toBe(200);
  });

  it('rejects Content-Length over MAX_UPLOAD before reading body', async () => {
    const h = harness();
    const { status, body } = await request(h, '/_matrix/media/v3/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_UPLOAD + 1),
      },
      body: bytes('tiny'),
    });
    expect(status).toBe(413);
    expect(body).toMatchObject({
      errcode: 'M_TOO_LARGE',
      error: 'File exceeds maximum upload size',
    });
    expect(h.media.puts).toHaveLength(0);
  });

  it('accepts Content-Length exactly at MAX_UPLOAD when body is small', async () => {
    // Header check uses >, so equality is allowed; actual body size is checked later.
    const h = harness();
    const { status } = await request(h, '/_matrix/media/v3/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/pdf',
        'Content-Length': String(MAX_UPLOAD),
      },
      body: bytes('pdf'),
    });
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// v3 download
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/download/:serverName/:mediaId', () => {
  it('serves local media with security headers and disposition', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'mid1', content_type: 'image/png', filename: 'a.png' })],
      r2: { mid1: { body: bytes('IMG') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/download/${SERVER}/mid1`
    );
    expect(status).toBe(200);
    expect(body).toBe('IMG');
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.get('Content-Disposition')).toBe('inline; filename="a.png"');
    expect(headers.get('Cache-Control')).toContain('immutable');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('defaults content-type when metadata missing and omits disposition', async () => {
    const h = harness({
      r2: { orphan: { body: bytes('ORPH') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/download/${SERVER}/orphan`
    );
    expect(status).toBe(200);
    expect(body).toBe('ORPH');
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.get('Content-Disposition')).toBeNull();
  });

  it('rejects remote server names', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/download/other.server/mid1'
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: 'Remote media not supported',
    });
  });

  it('returns 404 when R2 object missing', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'gone' })],
    });
    const { status, body } = await request(
      h,
      `/_matrix/media/v3/download/${SERVER}/gone`
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Media not found' });
  });
});

describe('GET /_matrix/media/v3/download/:serverName/:mediaId/:filename', () => {
  it('uses requested filename in Content-Disposition (sanitized)', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'mid1', content_type: 'text/plain' })],
      r2: { mid1: { body: bytes('hi') } },
    });
    const { status, headers, body } = await request(
      h,
      `/_matrix/media/v3/download/${SERVER}/mid1/${encodeURIComponent('my file.txt')}`
    );
    expect(status).toBe(200);
    expect(body).toBe('hi');
    expect(headers.get('Content-Type')).toBe('text/plain');
    expect(headers.get('Content-Disposition')).toBe('inline; filename="my_file.txt"');
  });

  it('rejects remote and missing objects', async () => {
    const h = harness();
    const remote = await request(h, '/_matrix/media/v3/download/x.org/m/f.png');
    expect(remote.status).toBe(404);
    expect(remote.body).toMatchObject({ error: 'Remote media not supported' });

    const missing = await request(h, `/_matrix/media/v3/download/${SERVER}/nope/f.png`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'Media not found' });
  });

  it('falls back content-type when DB row absent', async () => {
    const h = harness({ r2: { mid: { body: bytes('z') } } });
    const { status, headers } = await request(
      h,
      `/_matrix/media/v3/download/${SERVER}/mid/name.bin`
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });
});

// ---------------------------------------------------------------------------
// v3 thumbnail
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/thumbnail/:serverName/:mediaId', () => {
  it('rejects remote media', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/thumbnail/remote.org/mid?width=32&height=32'
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'Remote media not supported' });
  });

  it('404 when media metadata missing', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/unknown`
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'Media not found' });
  });

  it('returns cached thumbnail when present', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'img1', content_type: 'image/png' })],
      r2: {
        'thumb_img1_64x64_scale': { body: bytes('THUMB') },
      },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/img1?width=64&height=64&method=scale`
    );
    expect(status).toBe(200);
    expect(body).toBe('THUMB');
    expect(headers.get('Content-Type')).toBe('image/jpeg');
    expect(h.media.gets[0]).toBe('thumb_img1_64x64_scale');
    // Should not fetch original when cache hit
    expect(h.media.gets).not.toContain('img1');
  });

  it('returns original for non-image content without resize', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'pdf1', content_type: 'application/pdf' })],
      r2: { pdf1: { body: bytes('%PDF') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/pdf1?width=10&height=10`
    );
    expect(status).toBe(200);
    expect(body).toBe('%PDF');
    expect(headers.get('Content-Type')).toBe('application/pdf');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404 when original R2 object missing after metadata hit', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'ghost', content_type: 'image/png' })],
    });
    const { status, body } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/ghost`
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'Media not found' });
  });

  it('generates and caches thumbnail when cf image resize succeeds', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(bytes('JPEGTHUMB'), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    );
    const h = harness({
      rows: [seedRow({ media_id: 'img2', content_type: 'image/webp' })],
      r2: { img2: { body: bytes('WEBP') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/img2?width=32&height=48&method=crop`
    );
    expect(status).toBe(200);
    expect(body).toBe('JPEGTHUMB');
    expect(headers.get('Content-Type')).toBe('image/jpeg');
    expect(headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { cf?: { image?: Record<string, unknown> } }];
    expect(url).toBe(
      `https://${SERVER}/_matrix/media/v3/download/${SERVER}/img2`
    );
    expect(init.cf?.image).toMatchObject({
      width: 32,
      height: 48,
      fit: 'cover',
      format: 'jpeg',
      quality: 85,
    });
    expect(h.media.puts.some((p) => p.key === 'thumb_img2_32x48_crop')).toBe(true);
  });

  it('falls back to original when resize returns non-ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const h = harness({
      rows: [seedRow({ media_id: 'img3', content_type: 'image/png' })],
      r2: { img3: { body: bytes('ORIG') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/img3?width=16&height=16`
    );
    expect(status).toBe(200);
    expect(body).toBe('ORIG');
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.get('X-Thumbnail-Generated')).toBe('false');
  });

  it('falls back to original when resize throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('cf image unavailable'));
    const h = harness({
      rows: [seedRow({ media_id: 'img4', content_type: 'image/gif' })],
      r2: { img4: { body: bytes('GIF') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/img4`
    );
    expect(status).toBe(200);
    expect(body).toBe('GIF');
    expect(headers.get('X-Thumbnail-Generated')).toBe('false');
  });

  it('clamps width/height and defaults method to scale', async () => {
    fetchMock.mockResolvedValueOnce(new Response(bytes('T'), { status: 200 }));
    const h = harness({
      rows: [seedRow({ media_id: 'img5', content_type: 'image/png' })],
      r2: { img5: { body: bytes('P') } },
    });
    await request(
      h,
      `/_matrix/media/v3/thumbnail/${SERVER}/img5?width=99999&height=0`
    );
    const init = fetchMock.mock.calls[0][1] as { cf: { image: { width: number; height: number; fit: string } } };
    expect(init.cf.image.width).toBe(1920);
    // height '0' → parseInt 0 || fallback 96
    expect(init.cf.image.height).toBe(96);
    expect(init.cf.image.fit).toBe('contain');
    expect(h.media.puts.some((p) => p.key === 'thumb_img5_1920x96_scale')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v3 preview_url
// ---------------------------------------------------------------------------

describe('GET /_matrix/media/v3/preview_url', () => {
  it('requires url param', async () => {
    const h = harness();
    const { status, body } = await request(h, '/_matrix/media/v3/preview_url', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: url',
    });
  });

  it('rejects SSRF / blocked URLs', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('http://127.0.0.1/'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
    expect((body as { error: string }).error.length).toBeGreaterThan(0);
  });

  it('returns cached preview without fetching', async () => {
    const cached = { 'og:title': 'Cached' };
    const url = 'https://example.com/page';
    const h = harness({
      cache: { [`preview:${url}`]: JSON.stringify(cached) },
    });
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url) + '&ts=1',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns image OG fields for image Content-Type and caches', async () => {
    const url = 'https://cdn.example.com/pic.png';
    fetchMock.mockResolvedValueOnce(
      new Response(bytes('img'), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    );
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(h.cache.puts).toHaveLength(1);
    expect(h.cache.puts[0]).toMatchObject({
      key: `preview:${url}`,
      options: { expirationTtl: 3600 },
    });
  });

  it('returns empty object for non-HTML non-image content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://api.example.com/x'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(h.cache.puts).toHaveLength(0);
  });

  it('returns empty object when upstream is not ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 404 }));
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.com/404'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('parses HTML Open Graph tags and caches non-empty preview', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Hello &amp; World" />
        <meta property="og:description" content="Desc" />
        <meta property="og:image" content="/img.png" />
        <meta property="og:site_name" content="Site" />
        <meta property="og:type" content="website" />
      </head></html>`;
    fetchMock.mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
    const url = 'https://blog.example.com/post';
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      'og:title': 'Hello & World',
      'og:description': 'Desc',
      'og:image': 'https://blog.example.com/img.png',
      'og:site_name': 'Site',
      'og:type': 'website',
    });
    expect(h.cache.puts).toHaveLength(1);
  });

  it('does not cache empty HTML preview', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><body>no meta</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.com/empty'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(h.cache.puts).toHaveLength(0);
  });

  it('uses Browser Rendering when BROWSER binding succeeds', async () => {
    const basicHtml = '<html><title>Basic</title></html>';
    const browserHtml =
      '<html><head><meta property="og:title" content="FromBrowser" /></head></html>';
    fetchMock.mockResolvedValueOnce(
      new Response(basicHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const browserFetch = vi.fn(async () => new Response(browserHtml, { status: 200 }));
    const h = harness({ browser: { fetch: browserFetch } });
    const url = 'https://spa.example.com/app';
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent(url),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ 'og:title': 'FromBrowser' });
    expect(browserFetch).toHaveBeenCalled();
  });

  it('falls back to basic fetch HTML when Browser Rendering fails', async () => {
    const basicHtml =
      '<html><head><meta property="og:title" content="Fallback" /></head></html>';
    fetchMock.mockResolvedValueOnce(
      new Response(basicHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const h = harness({
      browser: {
        fetch: async () => {
          throw new Error('browser down');
        },
      },
    });
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.com/b'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ 'og:title': 'Fallback' });
  });

  it('falls back to basic fetch when Browser Rendering returns non-ok', async () => {
    const basicHtml =
      '<html><head><meta property="og:title" content="BasicOk" /></head></html>';
    fetchMock.mockResolvedValueOnce(
      new Response(basicHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const h = harness({
      browser: {
        fetch: async () => new Response('nope', { status: 503 }),
      },
    });
    const { body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.com/c'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(body).toEqual({ 'og:title': 'BasicOk' });
  });

  it('returns empty object when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' + encodeURIComponent('https://example.com/fail'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// MSC3916 authenticated upload / create / put
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v1/media/upload', () => {
  it('mirrors v3 upload success path', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/client/v1/media/upload?filename=a.jpg',
      uploadInit(bytes('JPEG'), { contentType: 'image/jpeg' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ content_uri: `mxc://${SERVER}/mediaid1` });
    expect(h.db.rows[0].filename).toBe('a.jpg');
  });

  it('rejects unsupported type and oversized Content-Length', async () => {
    const h = harness();
    const badType = await request(
      h,
      '/_matrix/client/v1/media/upload',
      uploadInit(bytes('x'), { contentType: 'application/x-msdownload' })
    );
    expect(badType.status).toBe(403);

    const tooBig = await request(h, '/_matrix/client/v1/media/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_UPLOAD + 10),
      },
      body: bytes('x'),
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ errcode: 'M_TOO_LARGE' });
  });
});

describe('POST /_matrix/client/v1/media/create', () => {
  it('creates placeholder with zero length and expiry', async () => {
    const h = harness();
    const before = Date.now();
    const { status, body } = await request(h, '/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    const after = Date.now();
    expect(status).toBe(200);
    const parsed = body as { content_uri: string; unused_expires_at: number };
    expect(parsed.content_uri).toBe(`mxc://${SERVER}/mediaid1`);
    expect(parsed.unused_expires_at).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 5);
    expect(parsed.unused_expires_at).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 5);
    expect(h.db.rows[0]).toMatchObject({
      media_id: 'mediaid1',
      user_id: USER,
      content_type: 'application/octet-stream',
      content_length: 0,
      filename: null,
    });
  });
});

describe('PUT /_matrix/client/v1/media/upload/:serverName/:mediaId', () => {
  it('uploads into owned empty placeholder', async () => {
    const h = harness({
      rows: [
        seedRow({
          media_id: 'ph1',
          content_length: 0,
          content_type: 'application/octet-stream',
        }),
      ],
    });
    const { status, body } = await request(
      h,
      `/_matrix/client/v1/media/upload/${SERVER}/ph1?filename=doc.pdf`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/pdf',
        },
        body: bytes('%PDF-1'),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(h.media.puts[0].key).toBe('ph1');
    expect(h.db.rows[0]).toMatchObject({
      content_type: 'application/pdf',
      content_length: 6,
      filename: 'doc.pdf',
    });
    expect(h.db.updates).toHaveLength(1);
  });

  it('rejects remote server', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/client/v1/media/upload/other.org/ph1',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
        body: bytes('x'),
      }
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot upload to remote server',
    });
  });

  it('404 when placeholder missing', async () => {
    const h = harness();
    const { status, body } = await request(
      h,
      `/_matrix/client/v1/media/upload/${SERVER}/nope`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
        body: bytes('x'),
      }
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('forbids upload when placeholder owned by another user', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'ph2', user_id: BOB, content_length: 0 })],
    });
    const { status, body } = await request(
      h,
      `/_matrix/client/v1/media/upload/${SERVER}/ph2`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
        body: bytes('x'),
      }
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not authorized to upload to this media',
    });
  });

  it('returns M_CANNOT_OVERWRITE_MEDIA when already uploaded', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'ph3', content_length: 12 })],
    });
    const { status, body } = await request(
      h,
      `/_matrix/client/v1/media/upload/${SERVER}/ph3`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
        body: bytes('x'),
      }
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      errcode: 'M_CANNOT_OVERWRITE_MEDIA',
      error: 'Media already uploaded',
    });
    expect(h.media.puts).toHaveLength(0);
  });

  it('stores empty filename when query omitted', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'ph4', content_length: 0 })],
    });
    await request(h, `/_matrix/client/v1/media/upload/${SERVER}/ph4`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
      body: bytes('hi'),
    });
    expect(h.media.puts[0].options?.customMetadata?.filename).toBe('');
    expect(h.db.rows[0].filename).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MSC3916 authenticated download / thumbnail / preview / config
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v1/media/download/:serverName/:mediaId', () => {
  it('serves authenticated download with headers', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'a1', filename: 'f.bin', content_type: 'application/pdf' })],
      r2: { a1: { body: bytes('PDF') } },
    });
    const { status, body, headers } = await request(
      h,
      `/_matrix/client/v1/media/download/${SERVER}/a1`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toBe('PDF');
    expect(headers.get('Content-Type')).toBe('application/pdf');
    expect(headers.get('Content-Disposition')).toBe('inline; filename="f.bin"');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects remote / missing; defaults type without metadata', async () => {
    const h = harness({ r2: { only: { body: bytes('o') } } });
    const remote = await request(h, '/_matrix/client/v1/media/download/x.org/only', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(remote.status).toBe(404);

    const missing = await request(h, `/_matrix/client/v1/media/download/${SERVER}/no`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(missing.status).toBe(404);

    const orphan = await request(h, `/_matrix/client/v1/media/download/${SERVER}/only`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(orphan.status).toBe(200);
    expect(orphan.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(orphan.headers.get('Content-Disposition')).toBeNull();
  });
});

describe('GET /_matrix/client/v1/media/download/:serverName/:mediaId/:filename', () => {
  it('sets disposition from path filename', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'b1', content_type: 'image/gif' })],
      r2: { b1: { body: bytes('G') } },
    });
    const { status, headers } = await request(
      h,
      `/_matrix/client/v1/media/download/${SERVER}/b1/cool.gif`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(headers.get('Content-Disposition')).toBe('inline; filename="cool.gif"');
  });

  it('rejects remote and missing', async () => {
    const h = harness();
    expect(
      (
        await request(h, '/_matrix/client/v1/media/download/r.org/m/f', {
          headers: { Authorization: 'Bearer t' },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await request(h, `/_matrix/client/v1/media/download/${SERVER}/m/f`, {
          headers: { Authorization: 'Bearer t' },
        })
      ).status
    ).toBe(404);
  });
});

describe('GET /_matrix/client/v1/media/thumbnail/:serverName/:mediaId', () => {
  it('rejects remote and missing metadata', async () => {
    const h = harness();
    expect(
      (
        await request(h, '/_matrix/client/v1/media/thumbnail/r.org/m', {
          headers: { Authorization: 'Bearer t' },
        })
      ).body
    ).toMatchObject({ error: 'Remote media not supported' });
    expect(
      (
        await request(h, `/_matrix/client/v1/media/thumbnail/${SERVER}/m`, {
          headers: { Authorization: 'Bearer t' },
        })
      ).body
    ).toMatchObject({ error: 'Media not found' });
  });

  it('returns original for non-image without X-Thumbnail-Generated; 404 missing object', async () => {
    const pdf = harness({
      rows: [seedRow({ media_id: 'p1', content_type: 'application/pdf' })],
      r2: { p1: { body: bytes('PDF') } },
    });
    const p = await request(
      pdf,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/p1`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(p.body).toBe('PDF');
    expect(p.headers.get('X-Thumbnail-Generated')).toBeNull();

    const ghost = harness({
      rows: [seedRow({ media_id: 'g1', content_type: 'image/png' })],
    });
    const g = await request(
      ghost,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/g1`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(g.status).toBe(404);
  });

  it('resizes images, falls back on failure, uses contain for scale', async () => {
    fetchMock.mockResolvedValueOnce(new Response(bytes('NEW'), { status: 200 }));
    const ok = harness({
      rows: [seedRow({ media_id: 'i1', content_type: 'image/png' })],
      r2: { i1: { body: bytes('SRC') } },
    });
    const r1 = await request(
      ok,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/i1?width=10&height=20&method=scale`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(r1.headers.get('X-Thumbnail-Generated')).toBe('true');
    expect(r1.body).toBe('NEW');
    const init = fetchMock.mock.calls[0][1] as { cf: { image: { fit: string } } };
    expect(init.cf.image.fit).toBe('contain');

    fetchMock.mockRejectedValueOnce(new Error('resize fail'));
    const fail = harness({
      rows: [seedRow({ media_id: 'i2', content_type: 'image/png' })],
      r2: { i2: { body: bytes('SRC2') } },
    });
    const r2 = await request(
      fail,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/i2`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(r2.body).toBe('SRC2');
    expect(r2.headers.get('X-Thumbnail-Generated')).toBe('false');

    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 502 }));
    const bad = harness({
      rows: [seedRow({ media_id: 'i3', content_type: 'image/png' })],
      r2: { i3: { body: bytes('SRC3') } },
    });
    const r3 = await request(
      bad,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/i3?method=crop`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(r3.body).toBe('SRC3');
    expect(r3.headers.get('X-Thumbnail-Generated')).toBe('false');
  });
});

describe('GET /_matrix/client/v1/media/preview_url', () => {
  it('requires url and rejects SSRF', async () => {
    const h = harness();
    const missing = await request(h, '/_matrix/client/v1/media/preview_url', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const ssrf = await request(
      h,
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent('http://localhost/'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(ssrf.status).toBe(400);
    expect(ssrf.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('serves cache, image, html, non-html, errors', async () => {
    const url = 'https://news.example.com/a';
    const cachedH = harness({
      cache: { [`preview:${url}`]: JSON.stringify({ 'og:title': 'Hit' }) },
    });
    const c = await request(
      cachedH,
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent(url),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(c.body).toEqual({ 'og:title': 'Hit' });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response('x', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    );
    const imgH = harness();
    const imgUrl = 'https://cdn.example.com/a.jpg';
    const img = await request(
      imgH,
      '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent(imgUrl),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(img.body).toEqual({ 'og:image': imgUrl, 'og:image:type': 'image/jpeg' });
    expect(imgH.cache.puts).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      new Response('<html><title>T</title></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const htmlH = harness();
    const html = await request(
      htmlH,
      '/_matrix/client/v1/media/preview_url?url=' +
        encodeURIComponent('https://example.com/t'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(html.body).toEqual({ 'og:title': 'T' });
    expect(htmlH.cache.puts).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      new Response('bin', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
    );
    const empty = await request(
      harness(),
      '/_matrix/client/v1/media/preview_url?url=' +
        encodeURIComponent('https://example.com/bin'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(empty.body).toEqual({});

    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    const bad = await request(
      harness(),
      '/_matrix/client/v1/media/preview_url?url=' +
        encodeURIComponent('https://example.com/500'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(bad.body).toEqual({});

    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const fail = await request(
      harness(),
      '/_matrix/client/v1/media/preview_url?url=' +
        encodeURIComponent('https://example.com/boom'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(fail.body).toEqual({});
  });

  it('does not cache empty HTML preview on v1', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const h = harness();
    const { body } = await request(
      h,
      '/_matrix/client/v1/media/preview_url?url=' +
        encodeURIComponent('https://example.com/blank'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(body).toEqual({});
    expect(h.cache.puts).toHaveLength(0);
  });
});

describe('GET /_matrix/client/v1/media/thumbnail cached path (explicit)', () => {
  it('hits thumb_ key before original', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'c1', content_type: 'image/png' })],
      r2: { 'thumb_c1_96x96_scale': { body: bytes('CACHED') } },
    });
    const { status, body } = await request(
      h,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/c1`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toBe('CACHED');
    expect(h.media.gets[0]).toBe('thumb_c1_96x96_scale');
    expect(h.media.gets).not.toContain('c1');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting / deeper edges
// ---------------------------------------------------------------------------

describe('media route edges (TOKENMAXX deepen)', () => {
  it('accepts each whitelisted MIME family on v3 upload', async () => {
    const types = [
      'image/gif',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'audio/mp3',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
      'application/json',
      'text/plain',
    ];
    for (const contentType of types) {
      const h = harness();
      const { status, body } = await request(
        h,
        '/_matrix/media/v3/upload',
        uploadInit(bytes('x'), { contentType })
      );
      expect(status).toBe(200);
      expect((body as { content_uri: string }).content_uri).toMatch(
        new RegExp(`^mxc://${SERVER}/mediaid`)
      );
      expect(h.db.rows[0].content_type).toBe(contentType);
    }
  });

  it('increments opaque media ids across sequential uploads', async () => {
    const h = harness();
    const a = await request(h, '/_matrix/media/v3/upload', uploadInit(bytes('a')));
    const b = await request(h, '/_matrix/media/v3/upload', uploadInit(bytes('b')));
    expect(a.body).toEqual({ content_uri: `mxc://${SERVER}/mediaid1` });
    expect(b.body).toEqual({ content_uri: `mxc://${SERVER}/mediaid2` });
    expect(h.media.puts.map((p) => p.key)).toEqual(['mediaid1', 'mediaid2']);
  });

  it('create → put → download end-to-end on MSC3916 paths', async () => {
    const h = harness();
    const created = await request(h, '/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    const mediaId = (created.body as { content_uri: string }).content_uri.split('/').pop()!;
    expect(mediaId).toBe('mediaid1');

    const put = await request(
      h,
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}?filename=shot.png`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
        body: bytes('PNGDATA'),
      }
    );
    expect(put.status).toBe(200);

    const dl = await request(
      h,
      `/_matrix/client/v1/media/download/${SERVER}/${mediaId}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(dl.status).toBe(200);
    expect(dl.body).toBe('PNGDATA');
    expect(dl.headers.get('Content-Type')).toBe('image/png');
    expect(dl.headers.get('Content-Disposition')).toBe('inline; filename="shot.png"');
  });

  it('second put after successful upload still cannot overwrite', async () => {
    const h = harness();
    await request(h, '/_matrix/client/v1/media/create', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    await request(h, `/_matrix/client/v1/media/upload/${SERVER}/mediaid1`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
      body: bytes('one'),
    });
    const second = await request(h, `/_matrix/client/v1/media/upload/${SERVER}/mediaid1`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'image/png' },
      body: bytes('two'),
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ errcode: 'M_CANNOT_OVERWRITE_MEDIA' });
    expect(h.media.puts).toHaveLength(1);
  });

  it('absolutizes relative og:image without leading slash', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<html><head><meta property="og:image" content="assets/pic.png" /></head></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      )
    );
    const h = harness();
    const { body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' +
        encodeURIComponent('https://cdn.example.com/page'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(body).toEqual({
      'og:image': 'https://cdn.example.com/assets/pic.png',
    });
  });

  it('keeps absolute http(s) og:image unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<html><head><meta content="https://i.example.com/x.png" property="og:image" /></head></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      )
    );
    const h = harness();
    const { body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' +
        encodeURIComponent('https://cdn.example.com/page'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(body).toEqual({ 'og:image': 'https://i.example.com/x.png' });
  });

  it('falls back to <title> and name=description when og tags absent', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<html><head><title>Plain Title</title><meta name="description" content="Plain Desc" /></head></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      )
    );
    const h = harness();
    const { body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' +
        encodeURIComponent('https://example.com/plain'),
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(body).toEqual({
      'og:title': 'Plain Title',
      'og:description': 'Plain Desc',
    });
  });

  it('rejects ftp and file URLs on both preview endpoints', async () => {
    for (const base of [
      '/_matrix/media/v3/preview_url',
      '/_matrix/client/v1/media/preview_url',
    ]) {
      const h = harness();
      for (const bad of ['ftp://example.com/a', 'file:///etc/passwd']) {
        const { status, body } = await request(
          h,
          `${base}?url=${encodeURIComponent(bad)}`,
          { headers: { Authorization: 'Bearer t' } }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
      }
    }
  });

  it('v3 and v1 config report the same upload size', async () => {
    const h = harness();
    const v3 = await request(h, '/_matrix/media/v3/config');
    const v1 = await request(h, '/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(v3.body).toEqual(v1.body);
    expect(v3.body).toEqual({ 'm.upload.size': MAX_UPLOAD });
  });

  it('download with filename still sets security headers', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'sec', content_type: 'image/png' })],
      r2: { sec: { body: bytes('S') } },
    });
    const { headers } = await request(
      h,
      `/_matrix/media/v3/download/${SERVER}/sec/name.png`
    );
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toContain("style-src 'unsafe-inline'");
  });

  it('v1 download with filename rejects remote and serves local', async () => {
    const h = harness({
      rows: [seedRow({ media_id: 'd1', content_type: 'text/plain' })],
      r2: { d1: { body: bytes('txt') } },
    });
    const remote = await request(h, '/_matrix/client/v1/media/download/x.org/d1/a.txt', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(remote.status).toBe(404);

    const local = await request(
      h,
      `/_matrix/client/v1/media/download/${SERVER}/d1/a.txt`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(local.status).toBe(200);
    expect(local.body).toBe('txt');
    expect(local.headers.get('Content-Disposition')).toBe('inline; filename="a.txt"');
  });

  it('thumbnail crop vs scale maps to cover vs contain on v1', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(bytes('A'), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes('B'), { status: 200 }));
    const h = harness({
      rows: [seedRow({ media_id: 'map', content_type: 'image/png' })],
      r2: { map: { body: bytes('SRC') } },
    });
    await request(
      h,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/map?width=8&height=8&method=crop`,
      { headers: { Authorization: 'Bearer t' } }
    );
    await request(
      h,
      `/_matrix/client/v1/media/thumbnail/${SERVER}/map?width=8&height=8&method=scale`,
      { headers: { Authorization: 'Bearer t' } }
    );
    const cropInit = fetchMock.mock.calls[0][1] as { cf: { image: { fit: string } } };
    const scaleInit = fetchMock.mock.calls[1][1] as { cf: { image: { fit: string } } };
    expect(cropInit.cf.image.fit).toBe('cover');
    expect(scaleInit.cf.image.fit).toBe('contain');
  });

  it('stores uploadedAt custom metadata as numeric string on upload', async () => {
    const before = Date.now();
    const h = harness();
    await request(h, '/_matrix/media/v3/upload', uploadInit(bytes('z')));
    const after = Date.now();
    const uploadedAt = Number(h.media.puts[0].options?.customMetadata?.uploadedAt);
    expect(uploadedAt).toBeGreaterThanOrEqual(before);
    expect(uploadedAt).toBeLessThanOrEqual(after);
  });

  it('records D1 content_length matching body byteLength', async () => {
    const h = harness();
    const payload = bytes('0123456789');
    await request(h, '/_matrix/client/v1/media/upload', uploadInit(payload));
    expect(h.db.rows[0].content_length).toBe(10);
    expect(h.db.inserts[0].args[3]).toBe(10);
  });

  it('preview_url ignores unused ts query but still works', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><title>Ts</title></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    const h = harness();
    const { status, body } = await request(
      h,
      '/_matrix/media/v3/preview_url?url=' +
        encodeURIComponent('https://example.com/ts') +
        '&ts=999',
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ 'og:title': 'Ts' });
  });

  it('rejects private IPv4 and metadata hosts on preview', async () => {
    const h = harness();
    for (const bad of [
      'http://10.0.0.1/',
      'http://192.168.0.2/',
      'http://169.254.169.254/latest',
      'http://metadata.google.internal/',
    ]) {
      const { status } = await request(
        h,
        '/_matrix/client/v1/media/preview_url?url=' + encodeURIComponent(bad),
        { headers: { Authorization: 'Bearer t' } }
      );
      expect(status).toBe(400);
    }
  });
});
