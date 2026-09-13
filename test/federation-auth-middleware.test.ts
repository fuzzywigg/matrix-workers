import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requireFederationAuth,
  optionalFederationAuth,
} from '../src/middleware/federation-auth';

const SERVER = 'matrix.example.com';
const NOW = 1_700_000_000_000;

vi.mock('../src/services/federation-keys', () => ({
  verifyRemoteSignature: vi.fn(),
}));

import { verifyRemoteSignature } from '../src/services/federation-keys';

const verifyMock = vi.mocked(verifyRemoteSignature);

function makeFedCtx(opts: {
  method?: string;
  url?: string;
  auth?: string | null;
  bodyText?: string;
  serverName?: string;
}) {
  const url = opts.url ?? `https://${SERVER}/_matrix/federation/v1/send/1`;
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.auth !== null && opts.auth !== undefined) {
    headers.Authorization = opts.auth;
  } else if (opts.auth === undefined) {
    // default: no Authorization
  }
  const store = new Map<string, unknown>();
  let bodyConsumed = false;
  return {
    req: {
      method,
      url,
      header: (name: string) => {
        if (name.toLowerCase() === 'authorization') return headers.Authorization;
        return undefined;
      },
      async text() {
        bodyConsumed = true;
        return opts.bodyText ?? '';
      },
      _bodyConsumed: () => bodyConsumed,
    },
    env: {
      SERVER_NAME: opts.serverName ?? SERVER,
      DB: {} as D1Database,
      CACHE: {} as KVNamespace,
    },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    _store: store,
  } as any;
}

const validAuth =
  'X-Matrix origin="remote.example.com",destination="matrix.example.com",key="ed25519:1",sig="abc"';

describe('requireFederationAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    verifyMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const next = vi.fn();
    const result = await requireFederationAuth()(makeFedCtx({ auth: null }), next);
    expect(result).toEqual({
      body: { errcode: 'M_UNAUTHORIZED', error: 'Missing Authorization header' },
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 401 for malformed Authorization header', async () => {
    const next = vi.fn();
    const result = await requireFederationAuth()(
      makeFedCtx({ auth: 'Bearer not-matrix' }),
      next
    );
    expect(result).toMatchObject({
      status: 401,
      body: { errcode: 'M_UNAUTHORIZED' },
    });
    expect((result as { body: { error: string } }).body.error).toContain('Invalid Authorization');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when destination mismatches SERVER_NAME', async () => {
    const next = vi.fn();
    const auth =
      'X-Matrix origin="remote.example.com",destination="other.example.com",key="ed25519:1",sig="s"';
    const result = await requireFederationAuth()(makeFedCtx({ auth }), next);
    expect(result).toEqual({
      body: {
        errcode: 'M_UNAUTHORIZED',
        error:
          'Request destination other.example.com does not match this server matrix.example.com',
      },
      status: 401,
    });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('allows matching destination and sets federationOrigin on valid sig', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'GET' });
    const next = vi.fn(async () => 'ok');
    await expect(requireFederationAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('federationOrigin')).toBe('remote.example.com');
    expect(verifyMock).toHaveBeenCalledOnce();
    const [signed] = verifyMock.mock.calls[0];
    expect(signed).toMatchObject({
      method: 'GET',
      origin: 'remote.example.com',
      destination: SERVER,
      signatures: { 'remote.example.com': { 'ed25519:1': 'abc' } },
    });
  });

  it('buffers POST JSON body onto federationBody / federationBodyRaw', async () => {
    verifyMock.mockResolvedValue(true);
    const body = { pdus: [{ type: 'm.room.message' }] };
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'POST',
      bodyText: JSON.stringify(body),
    });
    const next = vi.fn(async () => 'post');
    await expect(requireFederationAuth()(ctx, next)).resolves.toBe('post');
    expect(ctx.get('federationBody')).toEqual(body);
    expect(ctx.get('federationBodyRaw')).toBe(JSON.stringify(body));
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ content: body });
  });

  it('proceeds without content when POST body is invalid JSON', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'PUT',
      bodyText: '{not-json',
    });
    const next = vi.fn(async () => 'put');
    await expect(requireFederationAuth()(ctx, next)).resolves.toBe('put');
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('returns 401 when signature verification is false', async () => {
    verifyMock.mockResolvedValue(false);
    const next = vi.fn();
    const result = await requireFederationAuth()(makeFedCtx({ auth: validAuth }), next);
    expect(result).toEqual({
      body: { errcode: 'M_UNAUTHORIZED', error: 'Invalid request signature' },
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when verifyRemoteSignature throws (key-fetch failure)', async () => {
    verifyMock.mockRejectedValue(new Error('key fetch failed'));
    const next = vi.fn();
    const result = await requireFederationAuth()(makeFedCtx({ auth: validAuth }), next);
    expect(result).toEqual({
      body: { errcode: 'M_UNAUTHORIZED', error: 'Failed to verify request signature' },
      status: 401,
    });
  });

  it('skips destination check when destination param is absent', async () => {
    verifyMock.mockResolvedValue(true);
    const auth = 'X-Matrix origin="remote.example.com",key="ed25519:1",sig="abc"';
    const ctx = makeFedCtx({ auth });
    const next = vi.fn(async () => 'no-dest');
    await expect(requireFederationAuth()(ctx, next)).resolves.toBe('no-dest');
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ destination: SERVER });
  });

  it('includes query string in signed uri', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      url: `https://${SERVER}/_matrix/federation/v1/query/directory?room_alias=%23a%3As`,
    });
    const next = vi.fn(async () => 'q');
    await requireFederationAuth()(ctx, next);
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      uri: '/_matrix/federation/v1/query/directory?room_alias=%23a%3As',
    });
  });
});

describe('optionalFederationAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    verifyMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls next without auth when Authorization is absent', async () => {
    const ctx = makeFedCtx({ auth: null });
    const next = vi.fn(async () => 'anon');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('anon');
    expect(ctx.get('federationOrigin')).toBeUndefined();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('calls next without auth for non-X-Matrix Authorization', async () => {
    const ctx = makeFedCtx({ auth: 'Bearer tok' });
    const next = vi.fn(async () => 'bearer');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('bearer');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('sets federationOrigin when signature is valid', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth });
    const next = vi.fn(async () => 'ok');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('federationOrigin')).toBe('remote.example.com');
  });

  it('returns 401 when X-Matrix auth is present but signature is invalid', async () => {
    verifyMock.mockResolvedValue(false);
    const next = vi.fn();
    const result = await optionalFederationAuth()(makeFedCtx({ auth: validAuth }), next);
    expect(result).toEqual({
      body: { errcode: 'M_UNAUTHORIZED', error: 'Invalid request signature' },
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('proceeds unauthenticated when verify throws (key-fetch failure)', async () => {
    verifyMock.mockRejectedValue(new Error('keys unavailable'));
    const ctx = makeFedCtx({ auth: validAuth });
    const next = vi.fn(async () => 'degraded');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('degraded');
    expect(ctx.get('federationOrigin')).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('buffers POST body on optional auth success path', async () => {
    verifyMock.mockResolvedValue(true);
    const body = { hello: 1 };
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'POST',
      bodyText: JSON.stringify(body),
    });
    const next = vi.fn(async () => 'body');
    await optionalFederationAuth()(ctx, next);
    expect(ctx.get('federationBody')).toEqual(body);
    expect(ctx.get('federationBodyRaw')).toBe(JSON.stringify(body));
  });

  it('ignores unparseable optional auth header params and continues', async () => {
    // Starts with X-Matrix but missing required fields → parseAuthHeader null
    const ctx = makeFedCtx({ auth: 'X-Matrix origin="only"' });
    const next = vi.fn(async () => 'parse-fail');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('parse-fail');
    expect(verifyMock).not.toHaveBeenCalled();
  });
});


describe('requireFederationAuth TOKENMAXX edge paths after #82', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    verifyMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not buffer or set federationBody for empty POST bodyText', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '' });
    const next = vi.fn(async () => 'empty');
    await expect(requireFederationAuth()(ctx, next)).resolves.toBe('empty');
    expect(ctx.req._bodyConsumed()).toBe(true);
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(ctx.get('federationBodyRaw')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('does not read the body for GET requests even when bodyText is provided', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'GET',
      bodyText: JSON.stringify({ should: 'ignore' }),
    });
    const next = vi.fn(async () => 'get');
    await requireFederationAuth()(ctx, next);
    expect(ctx.req._bodyConsumed()).toBe(false);
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('does not read the body for DELETE / PATCH / HEAD', async () => {
    verifyMock.mockResolvedValue(true);
    for (const method of ['DELETE', 'PATCH', 'HEAD']) {
      verifyMock.mockClear();
      const ctx = makeFedCtx({
        auth: validAuth,
        method,
        bodyText: JSON.stringify({ x: 1 }),
      });
      await requireFederationAuth()(ctx, vi.fn(async () => 'ok'));
      expect(ctx.req._bodyConsumed()).toBe(false);
      expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
    }
  });

  it('buffers PUT JSON body the same as POST', async () => {
    verifyMock.mockResolvedValue(true);
    const body = { edus: [] };
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'PUT',
      bodyText: JSON.stringify(body),
    });
    await requireFederationAuth()(ctx, vi.fn(async () => 'put'));
    expect(ctx.get('federationBody')).toEqual(body);
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ content: body, method: 'PUT' });
  });

  it('uses pathname-only uri when the URL has no query string', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      url: `https://${SERVER}/_matrix/federation/v1/version`,
    });
    await requireFederationAuth()(ctx, vi.fn(async () => 'v'));
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      uri: '/_matrix/federation/v1/version',
    });
  });

  it('rejects quoted-empty destination captured as literal "" via unquoted fallback', async () => {
    // parseAuthHeader yields destination: '""' which !== SERVER_NAME
    const auth =
      'X-Matrix origin="remote.example.com",destination="",key="ed25519:1",sig="abc"';
    const next = vi.fn();
    const result = await requireFederationAuth()(makeFedCtx({ auth }), next);
    expect(result).toMatchObject({
      status: 401,
      body: { errcode: 'M_UNAUTHORIZED' },
    });
    expect((result as { body: { error: string } }).body.error).toContain('does not match');
    expect(verifyMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('includes empty-object content when POST body is "{}"', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '{}' });
    await requireFederationAuth()(ctx, vi.fn(async () => 'obj'));
    expect(ctx.get('federationBody')).toEqual({});
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ content: {} });
  });

  it('includes JSON null content when POST body is "null"', async () => {
    // bodyText is truthy; JSON.parse('null') → null; buildSignedRequest omits null content
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: 'null' });
    await requireFederationAuth()(ctx, vi.fn(async () => 'null-body'));
    expect(ctx.get('federationBody')).toBeNull();
    expect(ctx.get('federationBodyRaw')).toBe('null');
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('includes JSON array content when POST body is an array', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '[1,2]' });
    await requireFederationAuth()(ctx, vi.fn(async () => 'arr'));
    expect(ctx.get('federationBody')).toEqual([1, 2]);
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ content: [1, 2] });
  });

  it('passes DB and CACHE bindings through to verifyRemoteSignature', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth });
    await requireFederationAuth()(ctx, vi.fn(async () => 'bindings'));
    expect(verifyMock.mock.calls[0][1]).toBe('remote.example.com');
    expect(verifyMock.mock.calls[0][2]).toBe('ed25519:1');
    expect(verifyMock.mock.calls[0][3]).toBe(ctx.env.DB);
    expect(verifyMock.mock.calls[0][4]).toBe(ctx.env.CACHE);
  });

  it('does not set federationOrigin when signature verification fails', async () => {
    verifyMock.mockResolvedValue(false);
    const ctx = makeFedCtx({ auth: validAuth });
    await requireFederationAuth()(ctx, vi.fn());
    expect(ctx.get('federationOrigin')).toBeUndefined();
  });

  it('does not set federationOrigin when verify throws', async () => {
    verifyMock.mockRejectedValue(new Error('boom'));
    const ctx = makeFedCtx({ auth: validAuth });
    await requireFederationAuth()(ctx, vi.fn());
    expect(ctx.get('federationOrigin')).toBeUndefined();
  });
});

describe('optionalFederationAuth TOKENMAXX edge paths after #82', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    verifyMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does NOT check destination mismatch (unlike require) and still sets origin', async () => {
    verifyMock.mockResolvedValue(true);
    const auth =
      'X-Matrix origin="remote.example.com",destination="other.example.com",key="ed25519:1",sig="abc"';
    const ctx = makeFedCtx({ auth });
    const next = vi.fn(async () => 'mismatch-ok');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('mismatch-ok');
    expect(ctx.get('federationOrigin')).toBe('remote.example.com');
    expect(verifyMock).toHaveBeenCalledOnce();
    // signed request still uses local SERVER_NAME as destination
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ destination: SERVER });
  });

  it('continues without content when optional PUT body is invalid JSON', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'PUT',
      bodyText: '{not-json',
    });
    await expect(optionalFederationAuth()(ctx, vi.fn(async () => 'bad'))).resolves.toBe('bad');
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('does not set federationBody for empty optional POST body', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '' });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'e'));
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('skips body buffering for optional GET', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'GET',
      bodyText: JSON.stringify({ x: 1 }),
    });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'g'));
    expect(ctx.req._bodyConsumed()).toBe(false);
  });

  it('uses pathname-only uri on optional auth when no query string', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      url: `https://${SERVER}/_matrix/key/v2/server`,
    });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'key'));
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      uri: '/_matrix/key/v2/server',
    });
  });

  it('includes query string on optional auth signed uri', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      url: `https://${SERVER}/_matrix/federation/v1/query/profile?user_id=%40a%3As`,
    });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'q'));
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      uri: '/_matrix/federation/v1/query/profile?user_id=%40a%3As',
    });
  });

  it('rejects invalid signature even when destination mismatches (no silent degrade)', async () => {
    verifyMock.mockResolvedValue(false);
    const auth =
      'X-Matrix origin="remote.example.com",destination="evil.example.com",key="ed25519:1",sig="bad"';
    const next = vi.fn();
    const result = await optionalFederationAuth()(makeFedCtx({ auth }), next);
    expect(result).toEqual({
      body: { errcode: 'M_UNAUTHORIZED', error: 'Invalid request signature' },
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not set federationOrigin when optional verify throws', async () => {
    verifyMock.mockRejectedValue(new Error('keys down'));
    const ctx = makeFedCtx({ auth: validAuth });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'deg'));
    expect(ctx.get('federationOrigin')).toBeUndefined();
  });

  it('buffers optional POST empty-object body onto federationBody', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '{}' });
    await optionalFederationAuth()(ctx, vi.fn(async () => '{}'));
    expect(ctx.get('federationBody')).toEqual({});
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ content: {} });
  });

  it('allows optional auth without destination param', async () => {
    verifyMock.mockResolvedValue(true);
    const auth = 'X-Matrix origin="remote.example.com",key="ed25519:1",sig="abc"';
    const ctx = makeFedCtx({ auth });
    await expect(optionalFederationAuth()(ctx, vi.fn(async () => 'nd'))).resolves.toBe('nd');
    expect(ctx.get('federationOrigin')).toBe('remote.example.com');
  });
});
