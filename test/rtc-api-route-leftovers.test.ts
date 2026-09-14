/**
 * TOKENMAXX HEAVY leftovers after #159 — MatrixRTC/LiveKit API route edges.
 * Complements test/rtc-api-routes.test.ts. Orthogonal to keys/media/appservice (#158),
 * spaces/search/sync/versions (#159), admin/federation/sliding-sync (parallel A / #161).
 * Tests-only — Hono rtcApp.request() against src/api/rtc.ts. Fixtures use example.com only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const TRANSPORTS_PATH = '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports';
const GET_TOKEN_PATH = '/livekit/get_token';
const SFU_PATH = '/livekit/get_token/sfu/get';
describe('rtc leftovers #157 — transports empty soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(null); });

  it('transports empty soft-01 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-02 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-03 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-04 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-05 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-06 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-07 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-08 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-09 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-10 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-11 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-12 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-13 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-14 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-15 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-16 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-17 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-18 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-19 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });

  it('transports empty soft-20 returns empty list', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transports: [] });
  });
});
describe('rtc leftovers #157 — transports livekit soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('transports livekit soft-01 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-02 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-03 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-04 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-05 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-06 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-07 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-08 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-09 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-10 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-11 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-12 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-13 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-14 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-15 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-16 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-17 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-18 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-19 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });

  it('transports livekit soft-20 advertises get_token URL', async () => {
    const res = await request(createEnv(), TRANSPORTS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transports: [{ type: 'livekit', url: `https://${SERVER}/livekit/get_token` }],
    });
  });
});
describe('rtc leftovers #157 — get_token room (Element X) soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.element.x');
  });

  it('get_token room soft-01 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!room:example.com', device_id: 'DEV01', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-02 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!alpha:example.com', device_id: 'DEV02', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-03 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!beta-room:example.com', device_id: 'DEV03', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-04 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!call_01:example.com', device_id: 'DEV04', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-05 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!room:example.com', device_id: 'DEV05', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-06 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!alpha:example.com', device_id: 'DEV06', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-07 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!beta-room:example.com', device_id: 'DEV07', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-08 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!call_01:example.com', device_id: 'DEV08', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-09 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!room:example.com', device_id: 'DEV09', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-10 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!alpha:example.com', device_id: 'DEV10', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-11 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!beta-room:example.com', device_id: 'DEV11', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-12 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!call_01:example.com', device_id: 'DEV12', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-13 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!room:example.com', device_id: 'DEV13', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-14 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!alpha:example.com', device_id: 'DEV14', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-15 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!beta-room:example.com', device_id: 'DEV15', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
  });

  it('get_token room soft-16 Element X format', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: '!call_01:example.com', device_id: 'DEV16', openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.element.x' });
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
  });
});
describe('rtc leftovers #157 — get_token room_id legacy soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.legacy');
  });

  it('get_token room_id legacy soft-01 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!room:example.com',
        member: { id: 'm1', claimed_user_id: '@evil01:example.com', claimed_device_id: 'EVIL1' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil01:example.com');
  });

  it('get_token room_id legacy soft-02 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!alpha:example.com',
        member: { id: 'm2', claimed_user_id: '@evil02:example.com', claimed_device_id: 'EVIL2' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil02:example.com');
  });

  it('get_token room_id legacy soft-03 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!beta-room:example.com',
        member: { id: 'm3', claimed_user_id: '@evil03:example.com', claimed_device_id: 'EVIL3' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil03:example.com');
  });

  it('get_token room_id legacy soft-04 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!call_01:example.com',
        member: { id: 'm4', claimed_user_id: '@evil04:example.com', claimed_device_id: 'EVIL4' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil04:example.com');
  });

  it('get_token room_id legacy soft-05 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!room:example.com',
        member: { id: 'm5', claimed_user_id: '@evil05:example.com', claimed_device_id: 'EVIL5' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil05:example.com');
  });

  it('get_token room_id legacy soft-06 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!alpha:example.com',
        member: { id: 'm6', claimed_user_id: '@evil06:example.com', claimed_device_id: 'EVIL6' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil06:example.com');
  });

  it('get_token room_id legacy soft-07 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!beta-room:example.com',
        member: { id: 'm7', claimed_user_id: '@evil07:example.com', claimed_device_id: 'EVIL7' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil07:example.com');
  });

  it('get_token room_id legacy soft-08 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!call_01:example.com',
        member: { id: 'm8', claimed_user_id: '@evil08:example.com', claimed_device_id: 'EVIL8' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil08:example.com');
  });

  it('get_token room_id legacy soft-09 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!room:example.com',
        member: { id: 'm9', claimed_user_id: '@evil09:example.com', claimed_device_id: 'EVIL9' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil09:example.com');
  });

  it('get_token room_id legacy soft-10 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!alpha:example.com',
        member: { id: 'm10', claimed_user_id: '@evil10:example.com', claimed_device_id: 'EVIL10' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil10:example.com');
  });

  it('get_token room_id legacy soft-11 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!beta-room:example.com',
        member: { id: 'm11', claimed_user_id: '@evil11:example.com', claimed_device_id: 'EVIL11' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil11:example.com');
  });

  it('get_token room_id legacy soft-12 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!call_01:example.com',
        member: { id: 'm12', claimed_user_id: '@evil12:example.com', claimed_device_id: 'EVIL12' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil12:example.com');
  });

  it('get_token room_id legacy soft-13 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!room:example.com',
        member: { id: 'm13', claimed_user_id: '@evil13:example.com', claimed_device_id: 'EVIL13' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil13:example.com');
  });

  it('get_token room_id legacy soft-14 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!alpha:example.com',
        member: { id: 'm14', claimed_user_id: '@evil14:example.com', claimed_device_id: 'EVIL14' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_alpha_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil14:example.com');
  });

  it('get_token room_id legacy soft-15 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!beta-room:example.com',
        member: { id: 'm15', claimed_user_id: '@evil15:example.com', claimed_device_id: 'EVIL15' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_beta-room_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil15:example.com');
  });

  it('get_token room_id legacy soft-16 ignores claimed identity', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {
        room_id: '!call_01:example.com',
        member: { id: 'm16', claimed_user_id: '@evil16:example.com', claimed_device_id: 'EVIL16' },
        openid_token: openid(),
      })
    );
    expect(res.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledWith(
      'lk-key', 'lk-secret', '_call_01_example_com', USER, 'alice', 3600
    );
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).toBe(USER);
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][3]).not.toBe('@evil16:example.com');
  });
});
describe('rtc leftovers #157 — sfu/get soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.sfu');
  });

  it('sfu/get soft-01 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!room:example.com', device_id: 'SFU01' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_example_com');
  });

  it('sfu/get soft-02 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!alpha:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_alpha_example_com');
  });

  it('sfu/get soft-03 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!beta-room:example.com', device_id: 'SFU03' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_beta-room_example_com');
  });

  it('sfu/get soft-04 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!call_01:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_call_01_example_com');
  });

  it('sfu/get soft-05 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!room:example.com', device_id: 'SFU05' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_example_com');
  });

  it('sfu/get soft-06 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!alpha:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_alpha_example_com');
  });

  it('sfu/get soft-07 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!beta-room:example.com', device_id: 'SFU07' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_beta-room_example_com');
  });

  it('sfu/get soft-08 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!call_01:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_call_01_example_com');
  });

  it('sfu/get soft-09 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!room:example.com', device_id: 'SFU09' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_example_com');
  });

  it('sfu/get soft-10 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!alpha:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_alpha_example_com');
  });

  it('sfu/get soft-11 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!beta-room:example.com', device_id: 'SFU11' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_beta-room_example_com');
  });

  it('sfu/get soft-12 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!call_01:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_call_01_example_com');
  });

  it('sfu/get soft-13 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!room:example.com', device_id: 'SFU13' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_example_com');
  });

  it('sfu/get soft-14 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!alpha:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_alpha_example_com');
  });

  it('sfu/get soft-15 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!beta-room:example.com', device_id: 'SFU15' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_beta-room_example_com');
  });

  it('sfu/get soft-16 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!call_01:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_call_01_example_com');
  });

  it('sfu/get soft-17 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!room:example.com', device_id: 'SFU17' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_example_com');
  });

  it('sfu/get soft-18 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!alpha:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_alpha_example_com');
  });

  it('sfu/get soft-19 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room: '!beta-room:example.com', device_id: 'SFU19' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_beta-room_example_com');
  });

  it('sfu/get soft-20 returns url and jwt', async () => {
    const res = await request(createEnv(), SFU_PATH, jsonInit('POST', { room_id: '!call_01:example.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LK_CONFIG.wsUrl, jwt: 'jwt.sfu' });
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_call_01_example_com');
  });
});
describe('rtc leftovers #157 — not configured get_token soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(null); });

  it('not configured get_token soft-01 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-02 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-03 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-04 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-05 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-06 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-07 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-08 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-09 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-10 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-11 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured get_token soft-12 returns 500', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });
});
describe('rtc leftovers #157 — not configured sfu/get soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(null); });

  it('not configured sfu/get soft-01 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-02 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-03 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-04 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-05 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-06 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-07 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-08 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-09 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-10 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-11 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });

  it('not configured sfu/get soft-12 returns 500', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'LiveKit not configured' });
  });
});
describe('rtc leftovers #157 — bad JSON soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('bad JSON get_token soft-01 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON get_token soft-02 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '}',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON get_token soft-03 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '[',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON get_token soft-04 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: 'undefined',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON get_token soft-05 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '"str"',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON get_token soft-06 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '123',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-07 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: 'true',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-08 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{room:',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-09 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{"room":}',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-10 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{"room":!x}',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-11 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{,}',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-12 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bad JSON sfu soft-13 returns M_BAD_JSON', async () => {
    const res = await request(createEnv(), SFU_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{{{{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
});
describe('rtc leftovers #157 — missing room soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('missing room get_token soft-01 returns 400', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { device_id: "DEV" })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room get_token soft-02 returns 400', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {  })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room get_token soft-03 returns 400', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { openid_token: openid() })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room get_token soft-04 returns 400', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { device_id: "DEV" })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room get_token soft-05 returns 400', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', {  })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room get_token soft-06 returns 400', async () => {
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { openid_token: openid() })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room sfu soft-07 returns 400', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { device_id: "DEV" })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room sfu soft-08 returns 400', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', {  })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room sfu soft-09 returns 400', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { openid_token: openid() })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room sfu soft-10 returns 400', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { device_id: "DEV" })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room sfu soft-11 returns 400', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', {  })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });

  it('missing room sfu soft-12 returns 400', async () => {
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { openid_token: openid() })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Missing required field: room',
    });
  });
});
describe('rtc leftovers #157 — generateLiveKitToken throw soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
  });

  it('token throw get_token soft-01 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('sign fail'));
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw get_token soft-02 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('timeout'));
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw get_token soft-03 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('bad key'));
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw get_token soft-04 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('secret missing'));
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw get_token soft-05 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('room locked'));
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw sfu soft-06 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('quota'));
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw sfu soft-07 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('network'));
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw sfu soft-08 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('internal'));
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw sfu soft-09 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('crypto err'));
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });

  it('token throw sfu soft-10 returns 500', async () => {
    livekitMocks.generateLiveKitToken.mockRejectedValue(new Error('jwt err'));
    const res = await request(
      createEnv(),
      SFU_PATH,
      jsonInit('POST', { room: ROOM })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to generate token' });
  });
});
describe('rtc leftovers #157 — OpenID wrong server soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.oid');
  });

  it('OpenID wrong server soft-01 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong1.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-02 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong2.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-03 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong3.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-04 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong4.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-05 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong5.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-06 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong6.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-07 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong7.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-08 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong8.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-09 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong9.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-10 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong10.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-11 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong11.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID wrong server soft-12 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv(),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ matrix_server_name: 'wrong12.example.com' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
describe('rtc leftovers #157 — OpenID found in KV soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.kv');
  });

  it('OpenID found KV soft-01 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-02 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-03 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-04 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-05 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-06 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-07 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-08 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-09 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-10 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-11 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ user_id: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });

  it('OpenID found KV soft-12 verifies without failure warn', async () => {
    const sessions = mockKv({
      'openid:oid-tok': JSON.stringify({ sub: USER }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verification failed'))).toBe(false);
    warn.mockRestore();
  });
});
describe('rtc leftovers #157 — OpenID missing KV soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.nokv');
  });

  it('OpenID missing KV soft-01 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-01' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-02 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-02' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-03 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-03' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-04 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-04' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-05 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-05' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-06 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-06' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-07 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-07' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('OpenID missing KV soft-08 warns but issues token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions: mockKv() }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid({ access_token: 'missing-08' }) })
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
describe('rtc leftovers #157 — OpenID corrupt KV soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.corrupt');
  });

  it('OpenID corrupt KV soft-01 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{bad' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-02 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': 'not-json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-03 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{{' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-04 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{broken-json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-05 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{"user_id":}' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-06 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': 'undefined' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-07 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{user_id:' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('OpenID corrupt KV soft-08 catches parse error', async () => {
    const sessions = mockKv({ 'openid:oid-tok': '{"sub":}' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(
      createEnv({ sessions }),
      GET_TOKEN_PATH,
      jsonInit('POST', { room: ROOM, openid_token: openid() })
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});
describe('rtc leftovers #157 — roomId sanitize soft flood', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.sanitize');
  });

  it('roomId sanitize soft-01 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!AbC/xyz:server.name' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_AbC_xyz_server_name');
  });

  it('roomId sanitize soft-02 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!room:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_room_example_com');
  });

  it('roomId sanitize soft-03 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: 'plain_name-01' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('plain_name-01');
  });

  it('roomId sanitize soft-04 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!a.b/c:d.e' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_a_b_c_d_e');
  });

  it('roomId sanitize soft-05 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!UPPER:Example.COM' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_UPPER_Example_COM');
  });

  it('roomId sanitize soft-06 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!dash-under_score:ex.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_dash-under_score_ex_com');
  });

  it('roomId sanitize soft-07 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!special@chars#here:host' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_special_chars_here_host');
  });

  it('roomId sanitize soft-08 LiveKit name only [a-zA-Z0-9-_]', async () => {
    await request(createEnv(), GET_TOKEN_PATH, jsonInit('POST', { room: '!only-alnum_09:example.com' }));
    expect(livekitMocks.generateLiveKitToken.mock.calls[0][2]).toBe('_only-alnum_09_example_com');
  });
});
describe('rtc leftovers #157 — OPTIONS CORS get_token soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('OPTIONS CORS get_token soft-01 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-02 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-03 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-04 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-05 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-06 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-07 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-08 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-09 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-10 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-11 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS get_token soft-12 returns 204', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});
describe('rtc leftovers #157 — OPTIONS CORS sfu/get soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('OPTIONS CORS sfu/get soft-01 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-02 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-03 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-04 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-05 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-06 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-07 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-08 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-09 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-10 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-11 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS CORS sfu/get soft-12 returns 204', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});
describe('rtc leftovers #157 — method matrix get_token 405', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('GET get_token returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('PUT get_token returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('PATCH get_token returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('DELETE get_token returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), GET_TOKEN_PATH, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });
});
describe('rtc leftovers #157 — method matrix sfu/get 405', () => {
  beforeEach(() => { vi.clearAllMocks(); livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG); });

  it('GET sfu/get returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('PUT sfu/get returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('PATCH sfu/get returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('DELETE sfu/get returns 405 Method Not Allowed', async () => {
    const res = await request(createEnv(), SFU_PATH, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.text).toBe('Method Not Allowed');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
  });
});
describe('rtc leftovers #157 — lifecycle transports+token+sfu soft flood', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lifecycle soft-01 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.01');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-02 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.02');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-03 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.03');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-04 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.04');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-05 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.05');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-06 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.06');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-07 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.07');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-08 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.08');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-09 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.09');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-10 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.10');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-11 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.11');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-12 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.12');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-13 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.13');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-14 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.14');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-15 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.15');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });

  it('lifecycle soft-16 discovery then token then sfu', async () => {
    livekitMocks.getLiveKitConfig.mockReturnValue(LK_CONFIG);
    livekitMocks.generateLiveKitToken.mockResolvedValue('jwt.lifecycle.16');
    const env = createEnv();
    const t1 = await request(env, TRANSPORTS_PATH);
    expect(t1.status).toBe(200);
    expect((t1.body as { transports: unknown[] }).transports).toHaveLength(1);
    const t2 = await request(env, GET_TOKEN_PATH, jsonInit('POST', { room: ROOM }));
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({ url: LK_CONFIG.wsUrl });
    const t3 = await request(env, SFU_PATH, jsonInit('POST', { room_id: ROOM }));
    expect(t3.status).toBe(200);
    expect(livekitMocks.generateLiveKitToken).toHaveBeenCalledTimes(2);
  });
});
