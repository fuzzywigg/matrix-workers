import { describe, it, expect } from 'vitest';
import versions from '../src/api/versions';
import type { Env } from '../src/types';

function env(partial: Partial<Env> = {}): Env {
  return {
    SERVER_NAME: 'matrix.example.com',
    SERVER_VERSION: '0.1.0-test',
    ...partial,
  } as Env;
}

async function getJson(path: string, bindings: Env = env()) {
  const res = await versions.request(`http://localhost${path}`, {}, bindings);
  return { status: res.status, body: await res.json() };
}

describe('versions module /.well-known/matrix/client', () => {
  it('returns m.homeserver.base_url and MSC3575 proxy from SERVER_NAME', async () => {
    const { status, body } = await getJson('/.well-known/matrix/client');
    expect(status).toBe(200);
    expect(body).toEqual({
      'm.homeserver': { base_url: 'https://matrix.example.com' },
      'org.matrix.msc3575.proxy': { url: 'https://matrix.example.com' },
    });
  });

  it('omits rtc_foci when LIVEKIT_URL is missing', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_API_KEY: 'k' })
    );
    expect(body).not.toHaveProperty('org.matrix.msc4143.rtc_foci');
  });

  it('omits rtc_foci when LIVEKIT_API_KEY is missing', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: 'wss://livekit.example.com' })
    );
    expect(body).not.toHaveProperty('org.matrix.msc4143.rtc_foci');
  });

  it('includes LiveKit foci when LIVEKIT_URL and LIVEKIT_API_KEY are both set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'devkey',
        // SECRET is not required for well-known advertisement
        LIVEKIT_API_SECRET: undefined,
      })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://matrix.example.com/livekit/get_token',
      },
    ]);
  });

  it('uses exact SERVER_NAME host without trailing slash or port rewriting', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ SERVER_NAME: 'matrix.fuzzywigg.com' })
    );
    expect(body['m.homeserver']).toEqual({ base_url: 'https://matrix.fuzzywigg.com' });
    expect(body['org.matrix.msc3575.proxy']).toEqual({ url: 'https://matrix.fuzzywigg.com' });
  });
});

describe('versions module /.well-known/matrix/server', () => {
  it('advertises m.server as SERVER_NAME:443', async () => {
    const { status, body } = await getJson('/.well-known/matrix/server');
    expect(status).toBe(200);
    expect(body).toEqual({ 'm.server': 'matrix.example.com:443' });
  });

  it('reflects alternate SERVER_NAME into m.server', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/server',
      env({ SERVER_NAME: 'hs.smtp.eth' })
    );
    expect(body).toEqual({ 'm.server': 'hs.smtp.eth:443' });
  });
});

describe('versions module /.well-known/openid-configuration', () => {
  it('derives issuer and OAuth endpoints from SERVER_NAME', async () => {
    const { status, body } = await getJson('/.well-known/openid-configuration');
    expect(status).toBe(200);
    expect(body.issuer).toBe('https://matrix.example.com');
    expect(body.authorization_endpoint).toBe('https://matrix.example.com/oauth/authorize');
    expect(body.token_endpoint).toBe('https://matrix.example.com/oauth/token');
    expect(body.userinfo_endpoint).toBe('https://matrix.example.com/oauth/userinfo');
    expect(body.jwks_uri).toBe('https://matrix.example.com/.well-known/jwks.json');
    expect(body.registration_endpoint).toBe('https://matrix.example.com/oauth/register');
    expect(body.revocation_endpoint).toBe('https://matrix.example.com/oauth/revoke');
    expect(body.introspection_endpoint).toBe('https://matrix.example.com/oauth/introspect');
  });

  it('includes required Matrix MSC2967 scopes and OIDC openid/profile/email', async () => {
    const { body } = await getJson('/.well-known/openid-configuration');
    expect(body.scopes_supported).toEqual([
      'openid',
      'profile',
      'email',
      'urn:matrix:org.matrix.msc2967.client:api:*',
      'urn:matrix:org.matrix.msc2967.client:device:*',
    ]);
  });

  it('pins response/grant/PKCE/auth method discovery fields for Element Web', async () => {
    const { body } = await getJson('/.well-known/openid-configuration');
    expect(body.response_types_supported).toEqual(['code']);
    expect(body.response_modes_supported).toEqual(['query', 'fragment']);
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(body.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_basic',
      'client_secret_post',
      'none',
    ]);
    expect(body.code_challenge_methods_supported).toEqual(['S256', 'plain']);
    expect(body.subject_types_supported).toEqual(['public']);
    expect(body.id_token_signing_alg_values_supported).toEqual(['RS256', 'ES256']);
    expect(body.claims_supported).toEqual([
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'name',
      'email',
    ]);
  });

  it('sets Matrix Authentication Service graphql_endpoint to null and account.issuer', async () => {
    const { body } = await getJson('/.well-known/openid-configuration');
    expect(body['org.matrix.matrix-authentication-service']).toEqual({
      graphql_endpoint: null,
      account: { issuer: 'https://matrix.example.com' },
    });
  });
});

describe('versions module /.well-known/jwks.json', () => {
  it('returns an empty JWKS placeholder', async () => {
    const { status, body } = await getJson('/.well-known/jwks.json');
    expect(status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });
});

describe('versions module /.well-known/matrix/support', () => {
  it('returns empty contacts and omits support_page when nothing is configured', async () => {
    const { status, body } = await getJson('/.well-known/matrix/support', env());
    expect(status).toBe(200);
    expect(body).toEqual({ contacts: [] });
    expect(body).not.toHaveProperty('support_page');
  });

  it('includes admin contact with only ADMIN_CONTACT_EMAIL', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin@example.com' })
    );
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: 'admin@example.com', matrix_id: undefined },
    ]);
  });

  it('includes admin contact with only ADMIN_CONTACT_MXID', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_MXID: '@admin:example.com' })
    );
    expect(body.contacts).toEqual([
      { role: 'm.role.admin', email_address: undefined, matrix_id: '@admin:example.com' },
    ]);
  });

  it('includes both email and matrix_id on a single admin contact', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({
        ADMIN_CONTACT_EMAIL: 'admin@example.com',
        ADMIN_CONTACT_MXID: '@admin:example.com',
      })
    );
    expect(body.contacts).toEqual([
      {
        role: 'm.role.admin',
        email_address: 'admin@example.com',
        matrix_id: '@admin:example.com',
      },
    ]);
  });

  it('includes support_page when SUPPORT_PAGE_URL is set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ SUPPORT_PAGE_URL: 'https://example.com/support' })
    );
    expect(body.support_page).toBe('https://example.com/support');
    expect(body.contacts).toEqual([]);
  });

  it('combines admin contact and support_page when both are configured', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({
        ADMIN_CONTACT_EMAIL: 'ops@example.com',
        SUPPORT_PAGE_URL: 'https://example.com/help',
      })
    );
    expect(body).toEqual({
      contacts: [
        { role: 'm.role.admin', email_address: 'ops@example.com', matrix_id: undefined },
      ],
      support_page: 'https://example.com/help',
    });
  });
});

describe('versions module /_matrix/client/versions', () => {
  it('returns the full CS API versions list ending in v1.12', async () => {
    const { status, body } = await getJson('/_matrix/client/versions');
    expect(status).toBe(200);
    expect(body.versions).toEqual([
      'r0.0.1',
      'r0.1.0',
      'r0.2.0',
      'r0.3.0',
      'r0.4.0',
      'r0.5.0',
      'r0.6.0',
      'r0.6.1',
      'v1.1',
      'v1.2',
      'v1.3',
      'v1.4',
      'v1.5',
      'v1.6',
      'v1.7',
      'v1.8',
      'v1.9',
      'v1.10',
      'v1.11',
      'v1.12',
    ]);
  });

  it('pins sliding-sync / MatrixRTC / E2EE unstable_features flags', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    const f = body.unstable_features as Record<string, boolean>;
    expect(f['org.matrix.msc3575']).toBe(true);
    expect(f['org.matrix.simplified_msc3575']).toBe(true);
    expect(f['org.matrix.msc3575.e2ee']).toBe(true);
    expect(f['org.matrix.msc3575.to_device']).toBe(true);
    expect(f['org.matrix.msc3575.account_data']).toBe(true);
    expect(f['org.matrix.msc3575.receipts']).toBe(true);
    expect(f['org.matrix.msc3575.typing']).toBe(true);
    expect(f['org.matrix.msc3575.presence']).toBe(true);
    expect(f['org.matrix.msc3401']).toBe(true);
    expect(f['org.matrix.msc4143']).toBe(true);
    expect(f['io.element.e2ee_forced.public']).toBe(false);
    expect(f['io.element.e2ee_forced.private']).toBe(false);
    expect(f['io.element.e2ee_forced.trusted_private']).toBe(false);
    expect(f['org.matrix.msc3026.busy_presence']).toBe(false);
    expect(f['org.matrix.msc3882']).toBe(false);
    expect(f['org.matrix.label_based_filtering']).toBe(true);
    expect(f['org.matrix.e2e_cross_signing']).toBe(true);
  });
});

describe('versions module /_matrix/federation/v1/version', () => {
  it('returns matrix-worker name and SERVER_VERSION', async () => {
    const { status, body } = await getJson('/_matrix/federation/v1/version');
    expect(status).toBe(200);
    expect(body).toEqual({
      server: { name: 'matrix-worker', version: '0.1.0-test' },
    });
  });

  it('reflects alternate SERVER_VERSION strings', async () => {
    const { body } = await getJson(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: '9.9.9-edge' })
    );
    expect(body.server).toEqual({ name: 'matrix-worker', version: '9.9.9-edge' });
  });

  it('passes through undefined SERVER_VERSION when unset on the binding', async () => {
    const { body } = await getJson(
      '/_matrix/federation/v1/version',
      { SERVER_NAME: 'matrix.example.com' } as Env
    );
    expect(body.server).toEqual({ name: 'matrix-worker', version: undefined });
  });
});

describe('versions TOKENMAXX HEAVY after #83 — discovery leftovers', () => {
  it('does not advertise rtc_foci when only LIVEKIT_API_SECRET is set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_API_SECRET: 'secret-only' })
    );
    expect(body).not.toHaveProperty('org.matrix.msc4143.rtc_foci');
  });

  it('keeps homeserver + proxy keys when rtc_foci is also present', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: 'wss://lk.test', LIVEKIT_API_KEY: 'k' })
    );
    expect(Object.keys(body).sort()).toEqual([
      'm.homeserver',
      'org.matrix.msc3575.proxy',
      'org.matrix.msc4143.rtc_foci',
    ]);
  });

  it('treats empty-string LIVEKIT_URL as falsy (no foci)', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: '', LIVEKIT_API_KEY: 'k' })
    );
    expect(body).not.toHaveProperty('org.matrix.msc4143.rtc_foci');
  });

  it('treats empty-string LIVEKIT_API_KEY as falsy (no foci)', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: 'wss://lk.test', LIVEKIT_API_KEY: '' })
    );
    expect(body).not.toHaveProperty('org.matrix.msc4143.rtc_foci');
  });

  it('does not invent a support contact when both admin fields are empty strings', async () => {
    // Empty strings are truthy for the || guard only if non-empty; '' || '' is ''.
    // Source: if (c.env.ADMIN_CONTACT_EMAIL || c.env.ADMIN_CONTACT_MXID)
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: '', ADMIN_CONTACT_MXID: '' })
    );
    expect(body.contacts).toEqual([]);
  });

  it('omits support_page when SUPPORT_PAGE_URL is empty string', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ SUPPORT_PAGE_URL: '' })
    );
    expect(body).not.toHaveProperty('support_page');
  });

  it('returns 404 for unknown paths on the versions sub-app', async () => {
    const res = await versions.request('http://localhost/_matrix/client/nope', {}, env());
    expect(res.status).toBe(404);
  });

  it('rejects non-GET methods on client versions', async () => {
    const res = await versions.request(
      'http://localhost/_matrix/client/versions',
      { method: 'POST' },
      env()
    );
    expect(res.status).toBe(404);
  });

  it('pins the exact unstable_features key set from source', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    expect(Object.keys(body.unstable_features as object).sort()).toEqual(
      [
        'io.element.e2ee_forced.private',
        'io.element.e2ee_forced.public',
        'io.element.e2ee_forced.trusted_private',
        'org.matrix.e2e_cross_signing',
        'org.matrix.label_based_filtering',
        'org.matrix.msc2285.stable',
        'org.matrix.msc2432',
        'org.matrix.msc3026.busy_presence',
        'org.matrix.msc3401',
        'org.matrix.msc3440.stable',
        'org.matrix.msc3575',
        'org.matrix.msc3575.account_data',
        'org.matrix.msc3575.e2ee',
        'org.matrix.msc3575.presence',
        'org.matrix.msc3575.receipts',
        'org.matrix.msc3575.to_device',
        'org.matrix.msc3575.typing',
        'org.matrix.msc3827.stable',
        'org.matrix.msc3881',
        'org.matrix.msc3882',
        'org.matrix.msc4143',
        'org.matrix.simplified_msc3575',
        'uk.half-shot.msc2666.query_mutual_rooms',
      ].sort()
    );
  });

  it('embeds SERVER_NAME into OIDC account.issuer identically to issuer', async () => {
    const { body } = await getJson(
      '/.well-known/openid-configuration',
      env({ SERVER_NAME: 'oidc.smtp.eth' })
    );
    expect(body.issuer).toBe('https://oidc.smtp.eth');
    expect(body['org.matrix.matrix-authentication-service'].account.issuer).toBe(
      'https://oidc.smtp.eth'
    );
    expect(body.jwks_uri).toBe('https://oidc.smtp.eth/.well-known/jwks.json');
  });

  it('returns application/json Content-Type on client versions', async () => {
    const res = await versions.request('http://localhost/_matrix/client/versions', {}, env());
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('returns application/json on well-known client discovery', async () => {
    const res = await versions.request(
      'http://localhost/.well-known/matrix/client',
      {},
      env()
    );
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('rejects PUT on federation version', async () => {
    const res = await versions.request(
      'http://localhost/_matrix/federation/v1/version',
      { method: 'PUT' },
      env()
    );
    expect(res.status).toBe(404);
  });

  it('rejects DELETE on openid-configuration', async () => {
    const res = await versions.request(
      'http://localhost/.well-known/openid-configuration',
      { method: 'DELETE' },
      env()
    );
    expect(res.status).toBe(404);
  });

  it('passes through empty-string SERVER_VERSION on federation version', async () => {
    const { body } = await getJson(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: '' })
    );
    expect(body.server).toEqual({ name: 'matrix-worker', version: '' });
  });

  it('advertises livekit_service_url under the CS HTTPS origin not the LIVEKIT_URL host', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({
        SERVER_NAME: 'matrix.fuzzywigg.com',
        LIVEKIT_URL: 'wss://livekit-elsewhere.example.com',
        LIVEKIT_API_KEY: 'k',
      })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://matrix.fuzzywigg.com/livekit/get_token',
      },
    ]);
  });

  it('creates a contact when only ADMIN_CONTACT_EMAIL is a non-empty string and MXID is empty', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'solo@example.com', ADMIN_CONTACT_MXID: '' })
    );
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].email_address).toBe('solo@example.com');
    expect(body.contacts[0].matrix_id).toBe('');
  });

  it('creates a contact when only ADMIN_CONTACT_MXID is set and EMAIL is empty', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: '', ADMIN_CONTACT_MXID: '@solo:example.com' })
    );
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].email_address).toBe('');
    expect(body.contacts[0].matrix_id).toBe('@solo:example.com');
  });

  it('pins remaining MSC flag values from the versions payload', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    const f = body.unstable_features as Record<string, boolean>;
    expect(f['org.matrix.msc2432']).toBe(true);
    expect(f['org.matrix.msc3440.stable']).toBe(true);
    expect(f['uk.half-shot.msc2666.query_mutual_rooms']).toBe(true);
    expect(f['org.matrix.msc2285.stable']).toBe(true);
    expect(f['org.matrix.msc3827.stable']).toBe(true);
    expect(f['org.matrix.msc3881']).toBe(true);
  });

  it('keeps client/versions independent of SERVER_NAME and LiveKit env', async () => {
    const a = await getJson(
      '/_matrix/client/versions',
      env({ SERVER_NAME: 'a.example.com' })
    );
    const b = await getJson(
      '/_matrix/client/versions',
      env({
        SERVER_NAME: 'b.example.com',
        LIVEKIT_URL: 'wss://x',
        LIVEKIT_API_KEY: 'k',
      })
    );
    expect(a.body).toEqual(b.body);
  });

  it('builds OAuth endpoints with the same https base as homeserver discovery', async () => {
    const client = await getJson(
      '/.well-known/matrix/client',
      env({ SERVER_NAME: 'hs.example.org' })
    );
    const oidc = await getJson(
      '/.well-known/openid-configuration',
      env({ SERVER_NAME: 'hs.example.org' })
    );
    const base = (client.body['m.homeserver'] as { base_url: string }).base_url;
    expect(oidc.body.issuer).toBe(base);
    expect(oidc.body.authorization_endpoint.startsWith(base + '/')).toBe(true);
    expect(oidc.body.token_endpoint.startsWith(base + '/')).toBe(true);
  });

  it('always uses port 443 in m.server regardless of SERVER_VERSION', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/server',
      env({ SERVER_NAME: 'fed.example.com', SERVER_VERSION: 'totally-ignored-here' })
    );
    expect(body).toEqual({ 'm.server': 'fed.example.com:443' });
  });

  it('returns JWKS keys as an empty array not null', async () => {
    const { body } = await getJson('/.well-known/jwks.json');
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(0);
  });
});
