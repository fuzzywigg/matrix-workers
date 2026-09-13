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

describe('requireFederationAuth TOKENMAXX leftovers after #81 (fed auth middleware)', () => {
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

  it('treats empty-string Authorization as missing (falsy header guard)', async () => {
    const next = vi.fn();
    const result = await requireFederationAuth()(makeFedCtx({ auth: '' }), next);
    expect(result).toEqual({
      body: { errcode: 'M_UNAUTHORIZED', error: 'Missing Authorization header' },
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for whitespace-only Authorization that fails X-Matrix parse', async () => {
    const next = vi.fn();
    const result = await requireFederationAuth()(makeFedCtx({ auth: '   ' }), next);
    expect(result).toMatchObject({
      status: 401,
      body: { errcode: 'M_UNAUTHORIZED' },
    });
    expect((result as { body: { error: string } }).body.error).toContain('Invalid Authorization');
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts unquoted X-Matrix params through the middleware path', async () => {
    verifyMock.mockResolvedValue(true);
    const auth =
      'X-Matrix origin=remote.example.com,destination=matrix.example.com,key=ed25519:1,sig=abc';
    const ctx = makeFedCtx({ auth });
    const next = vi.fn(async () => 'unquoted');
    await expect(requireFederationAuth()(ctx, next)).resolves.toBe('unquoted');
    expect(ctx.get('federationOrigin')).toBe('remote.example.com');
    expect(verifyMock.mock.calls[0][1]).toBe('remote.example.com');
    expect(verifyMock.mock.calls[0][2]).toBe('ed25519:1');
  });

  it('passes DB and CACHE bindings into verifyRemoteSignature', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth });
    await requireFederationAuth()(ctx, vi.fn(async () => 'ok'));
    expect(verifyMock.mock.calls[0][3]).toBe(ctx.env.DB);
    expect(verifyMock.mock.calls[0][4]).toBe(ctx.env.CACHE);
  });

  it('does not buffer or attach content on GET (body text unread)', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'GET',
      bodyText: '{"should":"not-read"}',
    });
    await requireFederationAuth()(ctx, vi.fn(async () => 'get'));
    expect(ctx.req._bodyConsumed()).toBe(false);
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('treats empty POST body as no content (no federationBody set)', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '' });
    await requireFederationAuth()(ctx, vi.fn(async () => 'empty'));
    expect(ctx.req._bodyConsumed()).toBe(true);
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(ctx.get('federationBodyRaw')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('buffers PUT JSON the same way as POST', async () => {
    verifyMock.mockResolvedValue(true);
    const body = { edus: [{ edu_type: 'm.presence' }] };
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'PUT',
      bodyText: JSON.stringify(body),
    });
    await requireFederationAuth()(ctx, vi.fn(async () => 'put-ok'));
    expect(ctx.get('federationBody')).toEqual(body);
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      method: 'PUT',
      content: body,
    });
  });

  it('uses SERVER_NAME as signed destination even when auth destination is omitted', async () => {
    verifyMock.mockResolvedValue(true);
    const auth = 'X-Matrix origin="remote.example.com",key="ed25519:1",sig="abc"';
    const ctx = makeFedCtx({ auth, serverName: 'homeserver.example.com' });
    await requireFederationAuth()(ctx, vi.fn(async () => 'dest'));
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      destination: 'homeserver.example.com',
      origin: 'remote.example.com',
    });
  });

  it('destination match is case-sensitive against SERVER_NAME', async () => {
    const next = vi.fn();
    const auth =
      'X-Matrix origin="remote.example.com",destination="Matrix.Example.Com",key="ed25519:1",sig="s"';
    const result = await requireFederationAuth()(
      makeFedCtx({ auth, serverName: 'matrix.example.com' }),
      next
    );
    expect(result).toMatchObject({ status: 401, body: { errcode: 'M_UNAUTHORIZED' } });
    expect((result as { body: { error: string } }).body.error).toContain('does not match');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('logs warn on invalid signature and error on verify throw', async () => {
    verifyMock.mockResolvedValueOnce(false);
    await requireFederationAuth()(makeFedCtx({ auth: validAuth }), vi.fn());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Federation auth failed for remote.example.com')
    );

    verifyMock.mockRejectedValueOnce(new Error('boom'));
    await requireFederationAuth()(makeFedCtx({ auth: validAuth }), vi.fn());
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Federation auth error for remote.example.com'),
      expect.any(Error)
    );
  });

  it('embeds signature under origin/key path on the verify payload', async () => {
    verifyMock.mockResolvedValue(true);
    const auth =
      'X-Matrix origin="remote.example.com",key="ed25519:custom",sig="SIGVALUE"';
    await requireFederationAuth()(makeFedCtx({ auth }), vi.fn(async () => 'sig'));
    expect(verifyMock.mock.calls[0][0]).toMatchObject({
      signatures: { 'remote.example.com': { 'ed25519:custom': 'SIGVALUE' } },
    });
  });

  it('does not attach content for DELETE (non POST/PUT)', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'DELETE',
      bodyText: '{"x":1}',
    });
    await requireFederationAuth()(ctx, vi.fn(async () => 'del'));
    expect(ctx.req._bodyConsumed()).toBe(false);
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });
});

describe('optionalFederationAuth TOKENMAXX leftovers after #81 (fed auth middleware)', () => {
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

  it('does not enforce destination mismatch (no destination gate on optional path)', async () => {
    verifyMock.mockResolvedValue(true);
    const auth =
      'X-Matrix origin="remote.example.com",destination="other.example.com",key="ed25519:1",sig="abc"';
    const ctx = makeFedCtx({ auth });
    const next = vi.fn(async () => 'optional-dest');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('optional-dest');
    expect(ctx.get('federationOrigin')).toBe('remote.example.com');
    // Signed request still uses local SERVER_NAME as destination
    expect(verifyMock.mock.calls[0][0]).toMatchObject({ destination: SERVER });
  });

  it('treats empty POST body as no content on optional path', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({ auth: validAuth, method: 'POST', bodyText: '' });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'empty'));
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('proceeds without content when optional PUT body is invalid JSON', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'PUT',
      bodyText: '{broken',
    });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'bad-json'));
    expect(ctx.get('federationBody')).toBeUndefined();
    expect(verifyMock.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('includes query string in signed uri on optional GET', async () => {
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

  it('logs warn when optional auth rejects an invalid signature', async () => {
    verifyMock.mockResolvedValue(false);
    await optionalFederationAuth()(makeFedCtx({ auth: validAuth }), vi.fn());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Optional auth: invalid signature from remote.example.com')
    );
  });

  it('logs warn then continues when optional verify throws', async () => {
    verifyMock.mockRejectedValue(new Error('notary down'));
    const ctx = makeFedCtx({ auth: validAuth });
    const next = vi.fn(async () => 'degraded');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('degraded');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Optional auth error for remote.example.com'),
      expect.any(Error)
    );
    expect(ctx.get('federationOrigin')).toBeUndefined();
  });

  it('accepts X-Matrix with trailing space-only params as unauthenticated', async () => {
    const ctx = makeFedCtx({ auth: 'X-Matrix ' });
    const next = vi.fn(async () => 'space');
    await expect(optionalFederationAuth()(ctx, next)).resolves.toBe('space');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('does not read body for optional GET even when bodyText is present', async () => {
    verifyMock.mockResolvedValue(true);
    const ctx = makeFedCtx({
      auth: validAuth,
      method: 'GET',
      bodyText: '{"no":true}',
    });
    await optionalFederationAuth()(ctx, vi.fn(async () => 'get'));
    expect(ctx.req._bodyConsumed()).toBe(false);
  });

  it('passes origin and key id into verifyRemoteSignature on optional success', async () => {
    verifyMock.mockResolvedValue(true);
    const auth =
      'X-Matrix origin="bridge.example.com",key="ed25519:bridge",sig="xyz"';
    await optionalFederationAuth()(makeFedCtx({ auth }), vi.fn(async () => 'ok'));
    expect(verifyMock.mock.calls[0][1]).toBe('bridge.example.com');
    expect(verifyMock.mock.calls[0][2]).toBe('ed25519:bridge');
  });
});
