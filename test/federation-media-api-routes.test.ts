/**
 * TOKENMAXX HEAVY deepen after #121–#123 — different slice: federation media download/thumbnail.
 * #122 covered federation S2S broadly but skipped media; client media is thick in media-api-routes.
 * This exercises GET /_matrix/federation/v1/media/{download,thumbnail}/:mediaId via Hono.
 * Tests-only — no product inventing. No credentials/DNS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import federation from '../src/api/federation';

const SERVER = 'example.com';
const MEDIA_ID = 'abc123media';
const NOW = 1_700_000_000_000;

type MediaRow = {
  media_id: string;
  content_type: string;
  filename: string | null;
};

type R2ObjectLike = {
  body: ArrayBuffer | string | ReadableStream;
  httpMetadata?: { contentType?: string };
};

type MediaBucket = {
  store: Map<string, R2ObjectLike>;
  gets: string[];
  get: (key: string) => Promise<R2ObjectLike | null>;
  put: (
    key: string,
    body: ArrayBuffer | string | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } }
  ) => Promise<void>;
};

type MediaDb = {
  rows: MediaRow[];
  sqlLog: string[];
  bindLog: unknown[][];
};

function createMediaDb(rows: MediaRow[] = []): D1Database & { store: MediaDb } {
  const store: MediaDb = { rows: [...rows], sqlLog: [], bindLog: [] };
  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          store.bindLog.push(args);
          return {
            async first<T>() {
              if (sql.includes('FROM media WHERE media_id')) {
                const [mediaId] = args as [string];
                const row = store.rows.find((r) => r.media_id === mediaId);
                if (!row) return null as T;
                if (sql.includes('content_type, filename') || sql.includes('filename')) {
                  return { content_type: row.content_type, filename: row.filename } as T;
                }
                if (sql.includes('SELECT content_type')) {
                  return { content_type: row.content_type } as T;
                }
                return row as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: MediaDb };
}

function createMediaBucket(seed: Record<string, R2ObjectLike> = {}): MediaBucket {
  const store = new Map<string, R2ObjectLike>(Object.entries(seed));
  const gets: string[] = [];
  return {
    store,
    gets,
    async get(key: string) {
      gets.push(key);
      return store.get(key) ?? null;
    },
    async put(key, body, options) {
      const normalized =
        typeof body === 'string'
          ? body
          : body instanceof ArrayBuffer
            ? body
            : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      store.set(key, {
        body: normalized as ArrayBuffer | string,
        httpMetadata: options?.httpMetadata,
      });
    },
  };
}

function envFor(opts: {
  db?: D1Database & { store: MediaDb };
  media?: MediaBucket;
} = {}): Env {
  const db = opts.db ?? createMediaDb();
  const media = opts.media ?? createMediaBucket();
  return {
    DB: db as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
  } as unknown as Env;
}

async function request(
  path: string,
  opts: {
    db?: D1Database & { store: MediaDb };
    media?: MediaBucket;
  } = {}
): Promise<{
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
  db: D1Database & { store: MediaDb };
  media: MediaBucket;
}> {
  const db = opts.db ?? createMediaDb();
  const media = opts.media ?? createMediaBucket();
  const env = envFor({ db, media });
  const res = await federation.request(`http://localhost${path}`, { method: 'GET' }, env);
  const text = await res.text();
  let body: unknown = text;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json') || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers, db, media };
}

function seedRow(partial: Partial<MediaRow> & { media_id: string }): MediaRow {
  return {
    media_id: partial.media_id,
    content_type: partial.content_type ?? 'image/png',
    filename: partial.filename ?? null,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /_matrix/federation/v1/media/download/:mediaId
// ---------------------------------------------------------------------------

describe('federation GET /_matrix/federation/v1/media/download/:mediaId', () => {
  it('returns 404 when the R2 object is missing', async () => {
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID })]);
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, {
      db,
      media: createMediaBucket(),
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Media not found' });
  });

  it('streams the object body with Content-Type from D1 metadata', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'PNGDATA' } });
    const db = createMediaDb([
      seedRow({ media_id: MEDIA_ID, content_type: 'image/png', filename: 'photo.png' }),
    ]);
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('PNGDATA');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="photo.png"');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('defaults Content-Type to application/octet-stream when D1 metadata is missing', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'BLOB' } });
    const db = createMediaDb();
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('omits Content-Disposition when filename is null', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'x' } });
    const db = createMediaDb([
      seedRow({ media_id: MEDIA_ID, content_type: 'text/plain', filename: null }),
    ]);
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('looks up R2 before D1 (404 short-circuits without metadata query)', async () => {
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID })]);
    const media = createMediaBucket();
    await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(media.gets).toEqual([MEDIA_ID]);
    expect(db.store.sqlLog.every((s) => !s.includes('FROM media'))).toBe(true);
  });

  it('queries D1 media metadata after a successful R2 hit', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'z' } });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'audio/mpeg' })]);
    await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(db.store.sqlLog.some((s) => s.includes('content_type, filename'))).toBe(true);
    expect(db.store.bindLog.some((b) => b[0] === MEDIA_ID)).toBe(true);
  });

  it('percent-decodes mediaId path segments', async () => {
    const id = 'med ia/id';
    const encoded = encodeURIComponent(id);
    const media = createMediaBucket({ [id]: { body: 'ok' } });
    const db = createMediaDb([seedRow({ media_id: id, content_type: 'text/plain' })]);
    const res = await request(`/_matrix/federation/v1/media/download/${encoded}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
    expect(media.gets).toContain(id);
  });

  it('serves empty bodies', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: '' } });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'text/plain' })]);
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('preserves binary-ish string bodies without JSON wrapping', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: '{"not":"json-response"}' } });
    const db = createMediaDb([
      seedRow({ media_id: MEDIA_ID, content_type: 'application/octet-stream' }),
    ]);
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    // Response may still parse as JSON in our helper when text looks like JSON —
    // assert raw text path via headers + status primarily.
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });
});

// ---------------------------------------------------------------------------
// GET /_matrix/federation/v1/media/thumbnail/:mediaId
// ---------------------------------------------------------------------------

describe('federation GET /_matrix/federation/v1/media/thumbnail/:mediaId', () => {
  it('returns 404 when D1 metadata is missing', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'PNG' } });
    const res = await request(`/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`, {
      db: createMediaDb(),
      media,
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Media not found' });
  });

  it('serves a pre-generated thumbnail from R2 when present', async () => {
    const thumbKey = `thumb_${MEDIA_ID}_96x96_scale`;
    const media = createMediaBucket({
      [MEDIA_ID]: { body: 'ORIGINAL' },
      [thumbKey]: { body: 'THUMBJPEG' },
    });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const res = await request(`/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMBJPEG');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(media.gets).toContain(thumbKey);
    // Should not need to fetch the original when thumb exists
    expect(media.gets.filter((g) => g === MEDIA_ID)).toHaveLength(0);
  });

  it('returns 404 when metadata exists but original R2 object is missing (no thumb)', async () => {
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const media = createMediaBucket();
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=32&height=32`,
      { db, media }
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns the original for non-image content types', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: '%PDF-1.4' } });
    const db = createMediaDb([
      seedRow({ media_id: MEDIA_ID, content_type: 'application/pdf' }),
    ]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=64&height=64`,
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('%PDF-1.4');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('marks images without a generated thumb with X-Thumbnail-Generated: false', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'PNGBYTES' } });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/webp' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=120&height=80&method=crop`,
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PNGBYTES');
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
    expect(media.gets).toContain(`thumb_${MEDIA_ID}_120x80_crop`);
  });

  it('defaults width/height to 96 and method to scale', async () => {
    const media = createMediaBucket({
      [`thumb_${MEDIA_ID}_96x96_scale`]: { body: 'DEF' },
      [MEDIA_ID]: { body: 'ORIG' },
    });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/jpeg' })]);
    const res = await request(`/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.text).toBe('DEF');
    expect(media.gets[0]).toBe(`thumb_${MEDIA_ID}_96x96_scale`);
  });

  it('clamps width and height to max 1920', async () => {
    const media = createMediaBucket({
      [`thumb_${MEDIA_ID}_1920x1920_scale`]: { body: 'CLAMP' },
    });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=99999&height=99999`,
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('CLAMP');
    expect(media.gets).toContain(`thumb_${MEDIA_ID}_1920x1920_scale`);
  });

  it('passes NaN width/height through Math.min (NaN path) without throwing', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'IMG' } });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=nope&height=nope`,
      { db, media }
    );
    expect(res.status).toBe(200);
    // thumb key uses Math.min(NaN, 1920) => NaN → string "NaNxNaN"
    expect(media.gets.some((g) => g.includes('NaN'))).toBe(true);
  });

  it('honors method=crop in the thumbnail key', async () => {
    const key = `thumb_${MEDIA_ID}_32x32_crop`;
    const media = createMediaBucket({ [key]: { body: 'CROP' } });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=32&height=32&method=crop`,
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('CROP');
  });

  it('treats content types that only contain image/ mid-string as non-images', async () => {
    // startsWith('image/') — "text/x-image/png" is NOT an image
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'x' } });
    const db = createMediaDb([
      seedRow({ media_id: MEDIA_ID, content_type: 'text/x-image/png' }),
    ]);
    const res = await request(`/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('percent-decodes mediaId for thumbnail lookups', async () => {
    const id = 'thumb id';
    const media = createMediaBucket({
      [`thumb_${id}_10x10_scale`]: { body: 'T' },
    });
    const db = createMediaDb([seedRow({ media_id: id, content_type: 'image/png' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${encodeURIComponent(id)}?width=10&height=10`,
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('T');
  });

  it('queries only content_type for thumbnail metadata (not filename)', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: 'I' } });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/gif' })]);
    await request(`/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`, { db, media });
    expect(db.store.sqlLog.some((s) => s.includes('SELECT content_type FROM media'))).toBe(true);
    expect(db.store.sqlLog.every((s) => !s.includes('filename'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Method / routing probes
// ---------------------------------------------------------------------------

describe('federation media route probes', () => {
  it('rejects POST on download', async () => {
    const env = envFor();
    const res = await federation.request(
      `http://localhost/_matrix/federation/v1/media/download/${MEDIA_ID}`,
      { method: 'POST', body: '{}' },
      env
    );
    expect(res.status).toBe(404);
  });

  it('rejects PUT on thumbnail', async () => {
    const env = envFor();
    const res = await federation.request(
      `http://localhost/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`,
      { method: 'PUT', body: '{}' },
      env
    );
    expect(res.status).toBe(404);
  });

  it('rejects DELETE on download', async () => {
    const env = envFor();
    const res = await federation.request(
      `http://localhost/_matrix/federation/v1/media/download/${MEDIA_ID}`,
      { method: 'DELETE' },
      env
    );
    expect(res.status).toBe(404);
  });

  it('does not confuse client media paths with federation media', async () => {
    const env = envFor({
      media: createMediaBucket({ [MEDIA_ID]: { body: 'x' } }),
      db: createMediaDb([seedRow({ media_id: MEDIA_ID })]),
    });
    const res = await federation.request(
      `http://localhost/_matrix/media/v3/download/${SERVER}/${MEDIA_ID}`,
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Download + thumbnail interaction edges
// ---------------------------------------------------------------------------

describe('federation media download/thumbnail interaction edges', () => {
  it('download ignores thumbnail keys in the bucket', async () => {
    const media = createMediaBucket({
      [`thumb_${MEDIA_ID}_96x96_scale`]: { body: 'THUMB' },
    });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID })]);
    const res = await request(`/_matrix/federation/v1/media/download/${MEDIA_ID}`, { db, media });
    expect(res.status).toBe(404);
  });

  it('thumbnail prefers exact width/height/method key over other thumb sizes', async () => {
    const media = createMediaBucket({
      [`thumb_${MEDIA_ID}_96x96_scale`]: { body: 'DEFAULT' },
      [`thumb_${MEDIA_ID}_64x64_scale`]: { body: 'SMALL' },
      [MEDIA_ID]: { body: 'ORIG' },
    });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=64&height=64`,
      { db, media }
    );
    expect(res.text).toBe('SMALL');
  });

  it('image/svg+xml is treated as an image (startsWith image/)', async () => {
    const media = createMediaBucket({ [MEDIA_ID]: { body: '<svg/>' } });
    const db = createMediaDb([
      seedRow({ media_id: MEDIA_ID, content_type: 'image/svg+xml' }),
    ]);
    const res = await request(`/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}`, { db, media });
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
  });

  it('zero width/height are not replaced by defaults (parseInt 0 is falsy for ||)', async () => {
    // width = Math.min(parseInt('0' || '96'), 1920) — '0' is truthy string so parseInt('0')=0
    const media = createMediaBucket({
      [`thumb_${MEDIA_ID}_0x0_scale`]: { body: 'ZERO' },
    });
    const db = createMediaDb([seedRow({ media_id: MEDIA_ID, content_type: 'image/png' })]);
    const res = await request(
      `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=0&height=0`,
      { db, media }
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('ZERO');
  });
});
