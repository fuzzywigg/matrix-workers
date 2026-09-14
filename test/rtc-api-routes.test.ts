/**
 * TOKENMAXX HEAVY deepen after #117 — different slice: MatrixRTC / LiveKit API routes.
 * Avoids sync (#117), rooms (#114), oidc/media (#115/#113), voip siblings tested separately.
 * Tests-only — no product inventing.
 * Exercises MSC4143 transports, /livekit/get_token (+ /sfu/get), CORS OPTIONS, 405.
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

const livekitMocks = vi.hoisted(() => ({
  getLiveKitConfig: vi.fn(),
  generateLiveKitToken: vi.fn(async () => 'jwt.pinned.token'),
}));

vi.mock('../src/services/livekit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/livekit')>();
  return {
    ...actual,
    getLiveKitConfig: livekitMocks.getLiveKitConfig,
    generateLiveKitToken: livekitMocks.generateLiveKitToken,
  };
});

import rtcApp from '../src/api/rtc';

const USER = '@alice:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const LK_ROOM = '_room_example_com'; // !room:example.com → sanitized

type KvPut = { key: string; value: string };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    data,
    puts,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
      puts.push({ key, value });
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

function createEnv(opts: { sessions?: ReturnType<typeof mockKv> } = {}) {
  const sessions = opts.sessions ?? mockKv();
  const env = {
    SERVER_NAME: SERVER,
    SESSIONS: sessions,
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret',
    LIVEKIT_URL: 'wss://livekit.example/rtc',
    _sessions: sessions,
  };
  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const res = await rtcApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const LK_CONFIG = {
  apiKey: 'lk-key',
  apiSecret: 'lk-secret',
  wsUrl: 'wss://livekit.example/rtc',
};

function openid(partial: Partial<{
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}> = {}) {
  return {
    access_token: 'oid-tok',
    token_type: 'Bearer',
    matrix_server_name: SERVER,
    expires_in: 3600,
    ...partial,
  };
}

// =============================================================================
// GET MSC4143 rtc/transports
// =============================================================================

describe('rtc GET /org.matrix.msc4143/rtc/transports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const path = '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports';

  it('returns empty transports when LiveKit not configured', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await request(createEnv(), path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('advertises livekit transport with SERVER_NAME URL when configured', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const res = await request(createEnv(), path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [
        {
          type: 'livekit',
          url: `https://${SERVER}/livekit/get_token`,
        },
      ],
    });
  });

  it('does not require auth (public discovery)', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await request(createEnv(), path); // no Authorization
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// POST /livekit/get_token
// =============================================================================

describe('rtc POST /livekit/get_token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.pinned.token');
  });

  const path = '/livekit/get_token';

  it('returns 500 when LiveKit not configured', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await request(
      createEnv(),
      path,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('returns 400 M_BAD_JSON for invalid JSON body', async () => {
    const res = await request(createEnv(), path, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns 400 when room and room_id both missing', async () => {
    const res = await request(
      createEnv(),
      path,
      jsonInit('POST', { openid_token: openid() })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('accepts Element X format (room) and returns url + jwt', async () => {
    const env = createEnv();
    const res = await request(
      env,
      path,
      jsonInit('POST', { room: ROOM, device_id: 'DEVICEA', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.pinned.token' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key',
      'lk-secret',
      LK_ROOM,
      USER,
      'alice',
      3600
    );
  });

  it('accepts legacy format (room_id + member)', async () => {
    const res = await request(
      createEnv(),
      path,
      jsonInit('POST', {
        room_id: ROOM,
        member: {
          id: 'ignored',
          claimed_user_id: '@evil:example.com',
          claimed_device_id: 'EVIL',
        },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    // Never trusts claimed identity — uses auth userId
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key',
      'lk-secret',
      LK_ROOM,
      USER,
      'alice',
      3600
    );
  });

  it('prefers room_id over room when both present', async () => {
    await request(
      createEnv(),
      path,
      jsonInit('POST', { room_id: '!a:example.com', room: '!b:example.com' })
    );
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key',
      'lk-secret',
      '_a_example_com',
      USER,
      'alice',
      3600
    );
  });

  it('sanitizes Matrix room IDs to LiveKit-safe names', async () => {
    await request(
      createEnv(),
      path,
      jsonInit('POST', { room: '!AbC/xyz:server.name' })
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_AbC_xyz_server_name');
  });

  it('warns but still issues token when OpenID verification fails (wrong server)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      path,
      jsonInit('POST', {
        room: ROOM,
        openid_token: openid({ matrix_server_name: 'other.example' }),
      })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns but still issues token when OpenID token missing from SESSIONS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      path,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('verifies OpenID token against SESSIONS when present (user_id field)', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      path,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    // No verification-failed warn when token found
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))
    ).toBe(false);
    warn.mockRestore();
  });

  it('verifies OpenID token using sub fallback when user_id absent', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const res = await request(
      createEnv({ sessions }),
      path,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
  });

  it('skips OpenID verification when openid_token omitted', async () => {
    const res = await request(createEnv(), path, jsonInit('POST', { room: ROOM }));
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalled();
  });

  it('returns 500 when generateLiveKitToken throws', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('sign fail'));
    const res = await request(createEnv(), path, jsonInit('POST', { room: ROOM }));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Failed to generate token',
    });
  });

  it('derives participantName from localpart (strip @ and domain)', async () => {
    await request(createEnv(), path, jsonInit('POST', { room: ROOM }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][4]).toBe('alice');
  });
});

// =============================================================================
// POST /livekit/get_token/sfu/get
// =============================================================================

describe('rtc POST /livekit/get_token/sfu/get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.sfu.token');
  });

  const path = '/livekit/get_token/sfu/get';

  it('mirrors get_token success path', async () => {
    const res = await request(
      createEnv(),
      path,
      jsonInit('POST', { room: ROOM, device_id: 'DEVICEA' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu.token' });
  });

  it('returns 500 when LiveKit not configured', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(null);
    const res = await request(createEnv(), path, jsonInit('POST', { room: ROOM }));
    expect(res.status).toBe(500);
  });

  it('returns 400 for bad JSON', async () => {
    const res = await request(createEnv(), path, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns 400 when room missing', async () => {
    const res = await request(createEnv(), path, jsonInit('POST', {}));
    expect(res.status).toBe(400);
  });

  it('warns on failed OpenID but still returns token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      path,
      jsonInit('POST', {
        room: ROOM,
        openid_token: openid({ matrix_server_name: 'evil.com' }),
      })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns 500 when token generation fails', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('x'));
    const res = await request(createEnv(), path, jsonInit('POST', { room_id: ROOM }));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to generate token' });
  });
});

// =============================================================================
// OPTIONS + method gating
// =============================================================================

describe('rtc OPTIONS and method not allowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
  });

  it('OPTIONS /livekit/get_token returns 204 with CORS headers', async () => {
    const res = await request(createEnv(), '/livekit/get_token', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS /livekit/get_token/sfu/get returns 204 with CORS headers', async () => {
    const res = await request(createEnv(), '/livekit/get_token/sfu/get', {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('GET /livekit/get_token returns 405 (Element X availability probe)', async () => {
    const res = await request(createEnv(), '/livekit/get_token', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('PUT /livekit/get_token returns 405', async () => {
    const res = await request(createEnv(), '/livekit/get_token', { method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('GET /livekit/get_token/sfu/get returns 405', async () => {
    const res = await request(createEnv(), '/livekit/get_token/sfu/get', {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('DELETE /livekit/get_token/sfu/get returns 405', async () => {
    const res = await request(createEnv(), '/livekit/get_token/sfu/get', {
      method: 'DELETE',
    });
    expect(res.status).toBe(405);
  });
});

// =============================================================================
// OpenID verifyOpenIDToken edges (via route)
// =============================================================================

describe('rtc OpenID verify edges via get_token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.x');
  });

  it('handles corrupt JSON in SESSIONS openid entry without throwing', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{bad' });
    // JSON.parse throws → catch in verifyOpenIDToken → null → warn path
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('SESSIONS get throwing is caught and treated as failed verify', async () => {
    const sessions = mockKv();
    sessions.get = async () => {
      throw new Error('kv down');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// =============================================================================
// TOKENMAXX leftovers
// =============================================================================

describe('rtc TOKENMAXX leftover edges after #117', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.leftover');
  });

  it('roomIdToLiveKitName leaves alphanumeric/-/_ unchanged', async () => {
    await request(
      createEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: 'room-name_01' })
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('room-name_01');
  });

  it('voids device_id from body or auth without affecting jwt identity', async () => {
    await request(
      createEnv(),
      '/livekit/get_token',
      jsonInit('POST', { room: ROOM, device_id: 'IGNORED' })
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
  });

  it('sfu/get accepts room_id legacy field', async () => {
    const res = await request(
      createEnv(),
      '/livekit/get_token/sfu/get',
      jsonInit('POST', { room_id: '!z:example.com' })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_z_example_com');
  });

  it('transports URL uses env.SERVER_NAME exactly', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    const env = createEnv();
    (env as { SERVER_NAME: string }).SERVER_NAME = 'matrix.fuzzywigg.test';
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports'
    );
    expect(res.body).toEqual({
      transports: [
        {
          type: 'livekit',
          url: 'https://matrix.fuzzywigg.test/livekit/get_token',
        },
      ],
    });
  });

  it('get_token and sfu/get share sanitized room naming', async () => {
    const env = createEnv();
    await request(env, '/livekit/get_token', jsonInit('POST', { room: ROOM }));
    await request(env, '/livekit/get_token/sfu/get', jsonInit('POST', { room: ROOM }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe(LK_ROOM);
    expect(livekitMocks.generateLiveKitToken.mock.calls[1][2]).toBe(LK_ROOM);
  });
});
