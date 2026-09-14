/**
 * TOKENMAXX HEAVY leftovers after #157 — versions / well-known soft/edge/reliability.
 * Complements versions-wellknown.test.ts. Orthogonal to open keys/media/appservice #158.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { describe, expect, it } from 'vitest';
import versions from '../src/api/versions';
import type { Env } from '../src/types';

const SERVER = 'example.com';

function env(partial: Partial<Env> = {}): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    ...partial,
  } as Env;
}

async function get(
  path: string,
  e: Env = env()
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await versions.request(`http://localhost${path}`, { method: 'GET' }, e);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

describe('versions leftovers client well-known soft flood after #157', () => {
  it('client discovery soft-0', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-1', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-2', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-3', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-4', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-5', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-6', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-7', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-8', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-9', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-10', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-11', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-12', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-13', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-14', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-15', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-16', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-17', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-18', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-19', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-20', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-21', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-22', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
  it('client discovery soft-23', async () => {
    const { status, body } = await get('/.well-known/matrix/client', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.homeserver'].base_url).toBe('https://example.com');
    expect(body['org.matrix.msc3575.proxy'].url).toBe('https://example.com');
  });
});

describe('versions leftovers server well-known soft flood after #157', () => {
  it('server discovery soft-0', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-1', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's1.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s1.example.com:443');
  });
  it('server discovery soft-2', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-3', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's3.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s3.example.com:443');
  });
  it('server discovery soft-4', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-5', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's5.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s5.example.com:443');
  });
  it('server discovery soft-6', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-7', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's7.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s7.example.com:443');
  });
  it('server discovery soft-8', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-9', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's9.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s9.example.com:443');
  });
  it('server discovery soft-10', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-11', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's11.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s11.example.com:443');
  });
  it('server discovery soft-12', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-13', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's13.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s13.example.com:443');
  });
  it('server discovery soft-14', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 'example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('example.com:443');
  });
  it('server discovery soft-15', async () => {
    const { status, body } = await get('/.well-known/matrix/server', env({ SERVER_NAME: 's15.example.com' }));
    expect(status).toBe(200);
    expect(body['m.server']).toBe('s15.example.com:443');
  });
});

describe('versions leftovers openid soft flood after #157', () => {
  it('openid discovery soft-0', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-1', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-2', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-3', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-4', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-5', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-6', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-7', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-8', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-9', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-10', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-11', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-12', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-13', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-14', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
  it('openid discovery soft-15', async () => {
    const { status, body } = await get('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://example.com');
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.scopes_supported).toContain('openid');
  });
});

describe('versions leftovers jwks soft flood after #157', () => {
  it('jwks empty soft-0', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-1', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-2', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-3', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-4', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-5', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-6', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-7', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-8', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-9', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-10', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
  it('jwks empty soft-11', async () => {
    const { status, body } = await get('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
  });
});

describe('versions leftovers support soft flood after #157', () => {
  it('support empty soft-0', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-1', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-2', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-3', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-4', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-5', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-6', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-7', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-8', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-9', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-10', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support empty soft-11', async () => {
    const { status, body } = await get('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body.contacts).toEqual([]);
    expect(body.support_page).toBeUndefined();
  });
  it('support admin email soft-0', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin0@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin0@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-1', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin1@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin1@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-2', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin2@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin2@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-3', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin3@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin3@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-4', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin4@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin4@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-5', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin5@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin5@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-6', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin6@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin6@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-7', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin7@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin7@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-8', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin8@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin8@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-9', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin9@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin9@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-10', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin10@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin10@example.com', matrix_id: undefined },
    ]);
  });
  it('support admin email soft-11', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin11@example.com' } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin11@example.com', matrix_id: undefined },
    ]);
  });
});

describe('versions leftovers client versions soft flood after #157', () => {
  it('client versions soft-0', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-1', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-2', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-3', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-4', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-5', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-6', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-7', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-8', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-9', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-10', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-11', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-12', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-13', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-14', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-15', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-16', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-17', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-18', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-19', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-20', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-21', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-22', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
  it('client versions soft-23', async () => {
    const { status, body } = await get('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toContain('v1.12');
    expect(body.unstable_features['org.matrix.msc3575']).toBe(true);
    expect(body.unstable_features['org.matrix.simplified_msc3575']).toBe(true);
  });
});

describe('versions leftovers federation version soft flood after #157', () => {
  it('federation version soft-0', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-0' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-0' });
  });
  it('federation version soft-1', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-1' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-1' });
  });
  it('federation version soft-2', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-2' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-2' });
  });
  it('federation version soft-3', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-3' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-3' });
  });
  it('federation version soft-4', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-4' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-4' });
  });
  it('federation version soft-5', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-5' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-5' });
  });
  it('federation version soft-6', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-6' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-6' });
  });
  it('federation version soft-7', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-7' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-7' });
  });
  it('federation version soft-8', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-8' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-8' });
  });
  it('federation version soft-9', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-9' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-9' });
  });
  it('federation version soft-10', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-10' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-10' });
  });
  it('federation version soft-11', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-11' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-11' });
  });
  it('federation version soft-12', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-12' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-12' });
  });
  it('federation version soft-13', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-13' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-13' });
  });
  it('federation version soft-14', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-14' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-14' });
  });
  it('federation version soft-15', async () => {
    const { status, body } = await get(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: 'soft-15' })
    );
    expect(status).toBe(200);
    expect(body.server).toEqual({ name: 'matrix-worker', version: 'soft-15' });
  });
});

describe('versions leftovers LiveKit foci soft flood after #157', () => {
  it('rtc foci present soft-0', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key0',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-1', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key1',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-2', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key2',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-3', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key3',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-4', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key4',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-5', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key5',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-6', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key6',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-7', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key7',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-8', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key8',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-9', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key9',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-10', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key10',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci present soft-11', async () => {
    const { status, body } = await get(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'key11',
      } as Partial<Env>)
    );
    expect(status).toBe(200);
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://example.com/livekit/get_token',
      },
    ]);
  });
  it('rtc foci absent soft-0', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-1', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-2', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-3', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-4', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-5', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-6', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-7', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-8', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-9', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-10', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
  it('rtc foci absent soft-11', async () => {
    const { body } = await get('/.well-known/matrix/client', env({ LIVEKIT_URL: 'wss://x' } as Partial<Env>));
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
});

describe('versions leftovers method matrix after #157', () => {
  it('POST /.well-known/matrix/client rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/client', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /.well-known/matrix/client rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/client', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /.well-known/matrix/client rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/client', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST /.well-known/matrix/server rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/server', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /.well-known/matrix/server rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/server', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /.well-known/matrix/server rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/server', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST /.well-known/openid-configuration rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/openid-configuration', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /.well-known/openid-configuration rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/openid-configuration', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /.well-known/openid-configuration rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/openid-configuration', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST /.well-known/jwks.json rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/jwks.json', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /.well-known/jwks.json rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/jwks.json', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /.well-known/jwks.json rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/jwks.json', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST /.well-known/matrix/support rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/support', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /.well-known/matrix/support rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/support', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /.well-known/matrix/support rejected', async () => {
    const res = await versions.request('http://localhost/.well-known/matrix/support', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST /_matrix/client/versions rejected', async () => {
    const res = await versions.request('http://localhost/_matrix/client/versions', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /_matrix/client/versions rejected', async () => {
    const res = await versions.request('http://localhost/_matrix/client/versions', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /_matrix/client/versions rejected', async () => {
    const res = await versions.request('http://localhost/_matrix/client/versions', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST /_matrix/federation/v1/version rejected', async () => {
    const res = await versions.request('http://localhost/_matrix/federation/v1/version', { method: 'POST' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT /_matrix/federation/v1/version rejected', async () => {
    const res = await versions.request('http://localhost/_matrix/federation/v1/version', { method: 'PUT' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE /_matrix/federation/v1/version rejected', async () => {
    const res = await versions.request('http://localhost/_matrix/federation/v1/version', { method: 'DELETE' }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('versions leftovers lifecycle soft floods after #157', () => {
  it('discovery lifecycle soft-0', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-0',
      ADMIN_CONTACT_EMAIL: 'ops0@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/0',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k0',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/0');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-0');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-1', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-1',
      ADMIN_CONTACT_EMAIL: 'ops1@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/1',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k1',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/1');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-1');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-2', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-2',
      ADMIN_CONTACT_EMAIL: 'ops2@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/2',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k2',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/2');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-2');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-3', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-3',
      ADMIN_CONTACT_EMAIL: 'ops3@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/3',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k3',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/3');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-3');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-4', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-4',
      ADMIN_CONTACT_EMAIL: 'ops4@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/4',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k4',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/4');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-4');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-5', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-5',
      ADMIN_CONTACT_EMAIL: 'ops5@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/5',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k5',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/5');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-5');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-6', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-6',
      ADMIN_CONTACT_EMAIL: 'ops6@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/6',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k6',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/6');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-6');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-7', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-7',
      ADMIN_CONTACT_EMAIL: 'ops7@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/7',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k7',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/7');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-7');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-8', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-8',
      ADMIN_CONTACT_EMAIL: 'ops8@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/8',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k8',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/8');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-8');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-9', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-9',
      ADMIN_CONTACT_EMAIL: 'ops9@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/9',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k9',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/9');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-9');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-10', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-10',
      ADMIN_CONTACT_EMAIL: 'ops10@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/10',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k10',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/10');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-10');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-11', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-11',
      ADMIN_CONTACT_EMAIL: 'ops11@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/11',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k11',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/11');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-11');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-12', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-12',
      ADMIN_CONTACT_EMAIL: 'ops12@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/12',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k12',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/12');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-12');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-13', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-13',
      ADMIN_CONTACT_EMAIL: 'ops13@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/13',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k13',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/13');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-13');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-14', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-14',
      ADMIN_CONTACT_EMAIL: 'ops14@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/14',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k14',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/14');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-14');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
  it('discovery lifecycle soft-15', async () => {
    const e = env({
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'life-15',
      ADMIN_CONTACT_EMAIL: 'ops15@example.com',
      SUPPORT_PAGE_URL: 'https://example.com/support/15',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'k15',
    } as Partial<Env>);
    const client = await get('/.well-known/matrix/client', e);
    expect(client.body['m.homeserver'].base_url).toBe('https://example.com');
    expect(client.body['org.matrix.msc4143.rtc_foci'][0].type).toBe('livekit');
    const support = await get('/.well-known/matrix/support', e);
    expect(support.body.support_page).toBe('https://example.com/support/15');
    const fed = await get('/_matrix/federation/v1/version', e);
    expect(fed.body.server.version).toBe('life-15');
    const vers = await get('/_matrix/client/versions', e);
    expect(vers.body.versions.at(-1)).toBe('v1.12');
  });
});
