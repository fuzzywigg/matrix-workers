/**
 * TOKENMAXX HEAVY deepen of versions / well-known discovery routes after #83.
 * Slice: src/api/versions.ts — not federation-auth, TURN/Calls, or push-rules.
 * Tests only; no production code changes.
 */
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
  const res = await versions.request(path, { method: 'GET' }, bindings);
  const body = await res.json();
  return { res, body: body as Record<string, unknown> };
}

const EXPECTED_CS_VERSIONS = [
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
];

describe('GET /.well-known/matrix/client TOKENMAXX after #83', () => {
  it('returns homeserver base_url and native sliding-sync proxy from SERVER_NAME', async () => {
    const { res, body } = await getJson('/.well-known/matrix/client');
    expect(res.status).toBe(200);
    expect(body['m.homeserver']).toEqual({
      base_url: 'https://matrix.example.com',
    });
    expect(body['org.matrix.msc3575.proxy']).toEqual({
      url: 'https://matrix.example.com',
    });
  });

  it('omits MatrixRTC foci when LIVEKIT_URL and LIVEKIT_API_KEY are both unset', async () => {
    const { body } = await getJson('/.well-known/matrix/client', env());
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });

  it('omits MatrixRTC foci when only LIVEKIT_URL is set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: 'wss://livekit.example.com' })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });

  it('omits MatrixRTC foci when only LIVEKIT_API_KEY is set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_API_KEY: 'devkey' })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });

  it('omits MatrixRTC foci when LIVEKIT_URL is empty string even with API key', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: '', LIVEKIT_API_KEY: 'devkey' })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });

  it('omits MatrixRTC foci when LIVEKIT_API_KEY is empty string even with URL', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: 'wss://livekit.example.com', LIVEKIT_API_KEY: '' })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });

  it('adds livekit rtc_foci when both LIVEKIT_URL and LIVEKIT_API_KEY are set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret',
      })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://matrix.example.com/livekit/get_token',
      },
    ]);
  });

  it('uses LIVEKIT_URL only as a gate — focus URL always derives from SERVER_NAME', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({
        SERVER_NAME: 'matrix.fuzzywigg.com',
        LIVEKIT_URL: 'wss://external-livekit.example.net',
        LIVEKIT_API_KEY: 'k',
      })
    );
    const foci = body['org.matrix.msc4143.rtc_foci'] as Array<{
      type: string;
      livekit_service_url: string;
    }>;
    expect(foci).toHaveLength(1);
    expect(foci[0].type).toBe('livekit');
    expect(foci[0].livekit_service_url).toBe(
      'https://matrix.fuzzywigg.com/livekit/get_token'
    );
    expect(foci[0].livekit_service_url).not.toContain('external-livekit');
  });

  it('propagates alternate SERVER_NAME into homeserver and proxy URLs', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ SERVER_NAME: 'm.smtp.eth' })
    );
    expect(body['m.homeserver']).toEqual({ base_url: 'https://m.smtp.eth' });
    expect(body['org.matrix.msc3575.proxy']).toEqual({ url: 'https://m.smtp.eth' });
  });

  it('does not include unrelated top-level keys beyond homeserver, proxy, and optional foci', async () => {
    const { body } = await getJson('/.well-known/matrix/client', env());
    expect(Object.keys(body).sort()).toEqual([
      'm.homeserver',
      'org.matrix.msc3575.proxy',
    ]);

    const { body: withRtc } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: 'wss://lk.example', LIVEKIT_API_KEY: 'k' })
    );
    expect(Object.keys(withRtc).sort()).toEqual([
      'm.homeserver',
      'org.matrix.msc3575.proxy',
      'org.matrix.msc4143.rtc_foci',
    ]);
  });
});

describe('GET /.well-known/matrix/server TOKENMAXX after #83', () => {
  it('returns m.server as SERVER_NAME:443', async () => {
    const { res, body } = await getJson('/.well-known/matrix/server');
    expect(res.status).toBe(200);
    expect(body).toEqual({ 'm.server': 'matrix.example.com:443' });
  });

  it('embeds alternate hostnames with the federation default port', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/server',
      env({ SERVER_NAME: 'matrix.fuzzywigg.com' })
    );
    expect(body).toEqual({ 'm.server': 'matrix.fuzzywigg.com:443' });
  });

  it('returns only the m.server key', async () => {
    const { body } = await getJson('/.well-known/matrix/server');
    expect(Object.keys(body)).toEqual(['m.server']);
  });
});

describe('GET /.well-known/openid-configuration TOKENMAXX after #83', () => {
  it('returns a full OIDC discovery document keyed off SERVER_NAME', async () => {
    const { res, body } = await getJson('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    expect(body.issuer).toBe('https://matrix.example.com');
    expect(body.authorization_endpoint).toBe('https://matrix.example.com/oauth/authorize');
    expect(body.token_endpoint).toBe('https://matrix.example.com/oauth/token');
    expect(body.userinfo_endpoint).toBe('https://matrix.example.com/oauth/userinfo');
    expect(body.jwks_uri).toBe('https://matrix.example.com/.well-known/jwks.json');
    expect(body.registration_endpoint).toBe('https://matrix.example.com/oauth/register');
    expect(body.revocation_endpoint).toBe('https://matrix.example.com/oauth/revoke');
    expect(body.introspection_endpoint).toBe('https://matrix.example.com/oauth/introspect');
  });

  it('advertises Matrix MSC2967 scopes alongside openid/profile/email', async () => {
    const { body } = await getJson('/.well-known/openid-configuration');
    expect(body.scopes_supported).toEqual([
      'openid',
      'profile',
      'email',
      'urn:matrix:org.matrix.msc2967.client:api:*',
      'urn:matrix:org.matrix.msc2967.client:device:*',
    ]);
  });

  it('advertises authorization_code + refresh_token and PKCE methods', async () => {
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
  });

  it('lists Element-required claims and matrix-authentication-service extension', async () => {
    const { body } = await getJson('/.well-known/openid-configuration');
    expect(body.claims_supported).toEqual([
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'name',
      'email',
    ]);
    expect(body['org.matrix.matrix-authentication-service']).toEqual({
      graphql_endpoint: null,
      account: { issuer: 'https://matrix.example.com' },
    });
  });

  it('rewrites every endpoint when SERVER_NAME changes', async () => {
    const { body } = await getJson(
      '/.well-known/openid-configuration',
      env({ SERVER_NAME: 'm.smtp.eth' })
    );
    const base = 'https://m.smtp.eth';
    expect(body.issuer).toBe(base);
    expect(body.jwks_uri).toBe(`${base}/.well-known/jwks.json`);
    expect(
      (body['org.matrix.matrix-authentication-service'] as { account: { issuer: string } })
        .account.issuer
    ).toBe(base);
  });
});

describe('GET /.well-known/jwks.json TOKENMAXX after #83', () => {
  it('returns an empty JWKS placeholder for opaque tokens', async () => {
    const { res, body } = await getJson('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });

  it('does not depend on SERVER_NAME or SERVER_VERSION', async () => {
    const { body } = await getJson(
      '/.well-known/jwks.json',
      env({ SERVER_NAME: 'other.example', SERVER_VERSION: '9.9.9' })
    );
    expect(body).toEqual({ keys: [] });
  });
});

describe('GET /.well-known/matrix/support TOKENMAXX after #83', () => {
  it('returns empty contacts when no admin contact env is set', async () => {
    const { res, body } = await getJson('/.well-known/matrix/support', env());
    expect(res.status).toBe(200);
    expect(body).toEqual({ contacts: [] });
    expect(body.support_page).toBeUndefined();
  });

  it('adds m.role.admin contact with email only', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: 'admin@example.com' })
    );
    expect(body.contacts).toEqual([
      {
        role: 'm.role.admin',
        email_address: 'admin@example.com',
        matrix_id: undefined,
      },
    ]);
  });

  it('adds m.role.admin contact with matrix_id only', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_MXID: '@admin:example.com' })
    );
    expect(body.contacts).toEqual([
      {
        role: 'm.role.admin',
        email_address: undefined,
        matrix_id: '@admin:example.com',
      },
    ]);
  });

  it('includes both email and mxid on a single admin contact', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({
        ADMIN_CONTACT_EMAIL: 'ops@example.com',
        ADMIN_CONTACT_MXID: '@ops:example.com',
      })
    );
    expect(body.contacts).toEqual([
      {
        role: 'm.role.admin',
        email_address: 'ops@example.com',
        matrix_id: '@ops:example.com',
      },
    ]);
    expect((body.contacts as unknown[]).length).toBe(1);
  });

  it('adds support_page when SUPPORT_PAGE_URL is set without contacts', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ SUPPORT_PAGE_URL: 'https://example.com/support' })
    );
    expect(body).toEqual({
      contacts: [],
      support_page: 'https://example.com/support',
    });
  });

  it('combines contacts and support_page when both are configured', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({
        ADMIN_CONTACT_EMAIL: 'help@example.com',
        ADMIN_CONTACT_MXID: '@help:example.com',
        SUPPORT_PAGE_URL: 'https://example.com/help',
      })
    );
    expect(body.support_page).toBe('https://example.com/help');
    expect(body.contacts).toEqual([
      {
        role: 'm.role.admin',
        email_address: 'help@example.com',
        matrix_id: '@help:example.com',
      },
    ]);
  });

  it('treats empty-string ADMIN_CONTACT_* as falsy (no contact entry)', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ ADMIN_CONTACT_EMAIL: '', ADMIN_CONTACT_MXID: '' })
    );
    expect(body).toEqual({ contacts: [] });
  });

  it('treats empty SUPPORT_PAGE_URL as falsy (omits support_page)', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/support',
      env({ SUPPORT_PAGE_URL: '' })
    );
    expect(body).toEqual({ contacts: [] });
    expect('support_page' in body).toBe(false);
  });
});

describe('GET /_matrix/client/versions TOKENMAXX after #83', () => {
  it('advertises the full CS API version ladder through v1.12', async () => {
    const { res, body } = await getJson('/_matrix/client/versions');
    expect(res.status).toBe(200);
    expect(body.versions).toEqual(EXPECTED_CS_VERSIONS);
    expect((body.versions as string[])[0]).toBe('r0.0.1');
    expect((body.versions as string[]).at(-1)).toBe('v1.12');
  });

  it('does not depend on SERVER_NAME or LiveKit env', async () => {
    const { body: a } = await getJson(
      '/_matrix/client/versions',
      env({ SERVER_NAME: 'a.example', LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k' })
    );
    const { body: b } = await getJson(
      '/_matrix/client/versions',
      env({ SERVER_NAME: 'b.example' })
    );
    expect(a).toEqual(b);
  });

  it('enables sliding sync, MatrixRTC, and related unstable features', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    const features = body.unstable_features as Record<string, boolean>;
    expect(features['org.matrix.msc3575']).toBe(true);
    expect(features['org.matrix.simplified_msc3575']).toBe(true);
    expect(features['org.matrix.msc3575.e2ee']).toBe(true);
    expect(features['org.matrix.msc3575.to_device']).toBe(true);
    expect(features['org.matrix.msc3575.account_data']).toBe(true);
    expect(features['org.matrix.msc3575.receipts']).toBe(true);
    expect(features['org.matrix.msc3575.typing']).toBe(true);
    expect(features['org.matrix.msc3575.presence']).toBe(true);
    expect(features['org.matrix.msc3401']).toBe(true);
    expect(features['org.matrix.msc4143']).toBe(true);
  });

  it('keeps Element e2ee_forced_* and busy_presence / msc3882 disabled', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    const features = body.unstable_features as Record<string, boolean>;
    expect(features['io.element.e2ee_forced.public']).toBe(false);
    expect(features['io.element.e2ee_forced.private']).toBe(false);
    expect(features['io.element.e2ee_forced.trusted_private']).toBe(false);
    expect(features['org.matrix.msc3026.busy_presence']).toBe(false);
    expect(features['org.matrix.msc3882']).toBe(false);
  });

  it('enables cross-signing, relations, and other stable MSC flags', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    const features = body.unstable_features as Record<string, boolean>;
    expect(features['org.matrix.label_based_filtering']).toBe(true);
    expect(features['org.matrix.e2e_cross_signing']).toBe(true);
    expect(features['org.matrix.msc2432']).toBe(true);
    expect(features['org.matrix.msc3440.stable']).toBe(true);
    expect(features['uk.half-shot.msc2666.query_mutual_rooms']).toBe(true);
    expect(features['org.matrix.msc2285.stable']).toBe(true);
    expect(features['org.matrix.msc3827.stable']).toBe(true);
    expect(features['org.matrix.msc3881']).toBe(true);
  });

  it('snapshots the full unstable_features map for Spec v1.17 clients', async () => {
    const { body } = await getJson('/_matrix/client/versions');
    expect(body.unstable_features).toEqual({
      'org.matrix.label_based_filtering': true,
      'org.matrix.e2e_cross_signing': true,
      'org.matrix.msc2432': true,
      'org.matrix.msc3440.stable': true,
      'uk.half-shot.msc2666.query_mutual_rooms': true,
      'io.element.e2ee_forced.public': false,
      'io.element.e2ee_forced.private': false,
      'io.element.e2ee_forced.trusted_private': false,
      'org.matrix.msc3026.busy_presence': false,
      'org.matrix.msc2285.stable': true,
      'org.matrix.msc3827.stable': true,
      'org.matrix.msc3881': true,
      'org.matrix.msc3882': false,
      'org.matrix.msc3401': true,
      'org.matrix.msc4143': true,
      'org.matrix.msc3575': true,
      'org.matrix.simplified_msc3575': true,
      'org.matrix.msc3575.e2ee': true,
      'org.matrix.msc3575.to_device': true,
      'org.matrix.msc3575.account_data': true,
      'org.matrix.msc3575.receipts': true,
      'org.matrix.msc3575.typing': true,
      'org.matrix.msc3575.presence': true,
    });
  });
});

describe('GET /_matrix/federation/v1/version TOKENMAXX after #83', () => {
  it('returns server.name matrix-worker and SERVER_VERSION', async () => {
    const { res, body } = await getJson('/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(body).toEqual({
      server: {
        name: 'matrix-worker',
        version: '0.1.0-test',
      },
    });
  });

  it('propagates alternate SERVER_VERSION values', async () => {
    const { body } = await getJson(
      '/_matrix/federation/v1/version',
      env({ SERVER_VERSION: '1.17.0-edge' })
    );
    expect(body).toEqual({
      server: { name: 'matrix-worker', version: '1.17.0-edge' },
    });
  });

  it('keeps server.name fixed regardless of SERVER_NAME', async () => {
    const { body } = await getJson(
      '/_matrix/federation/v1/version',
      env({ SERVER_NAME: 'matrix.fuzzywigg.com', SERVER_VERSION: 'build-42' })
    );
    expect((body.server as { name: string; version: string }).name).toBe('matrix-worker');
    expect((body.server as { name: string; version: string }).version).toBe('build-42');
  });
});

describe('versions routes method / path hygiene TOKENMAXX after #83', () => {
  const discoveryPaths = [
    '/.well-known/matrix/client',
    '/.well-known/matrix/server',
    '/.well-known/openid-configuration',
    '/.well-known/jwks.json',
    '/.well-known/matrix/support',
    '/_matrix/client/versions',
    '/_matrix/federation/v1/version',
  ] as const;

  it('rejects POST on discovery endpoints with 404 (GET-only routes)', async () => {
    for (const path of discoveryPaths) {
      const res = await versions.request(path, { method: 'POST' }, env());
      expect(res.status).toBe(404);
    }
  });

  it('rejects PUT and DELETE on discovery endpoints', async () => {
    for (const path of discoveryPaths) {
      expect((await versions.request(path, { method: 'PUT' }, env())).status).toBe(404);
      expect((await versions.request(path, { method: 'DELETE' }, env())).status).toBe(404);
    }
  });

  it('returns 404 for unknown well-known and version paths', async () => {
    const missing = await versions.request('/.well-known/matrix/unknown', {}, env());
    expect(missing.status).toBe(404);
    const missingVersions = await versions.request('/_matrix/client/v3/versions', {}, env());
    expect(missingVersions.status).toBe(404);
    const trailing = await versions.request('/.well-known/matrix/client/', {}, env());
    expect(trailing.status).toBe(404);
  });

  it('serves Content-Type application/json on all discovery GETs', async () => {
    for (const path of discoveryPaths) {
      const res = await versions.request(path, {}, env());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    }
  });

  it('ignores query strings on well-known and version GETs', async () => {
    const { res, body } = await getJson('/.well-known/matrix/server?x=1&access_token=nope');
    expect(res.status).toBe(200);
    expect(body).toEqual({ 'm.server': 'matrix.example.com:443' });

    const client = await getJson('/.well-known/matrix/client?client=element');
    expect(client.res.status).toBe(200);
    expect(client.body['m.homeserver']).toEqual({
      base_url: 'https://matrix.example.com',
    });

    const versionsRes = await getJson('/_matrix/client/versions?unstable=1');
    expect(versionsRes.res.status).toBe(200);
    expect(versionsRes.body.versions).toEqual(EXPECTED_CS_VERSIONS);
  });

  it('accepts absolute request URLs for discovery routes', async () => {
    const res = await versions.request(
      'https://matrix.example.com/.well-known/matrix/client',
      { method: 'GET' },
      env({ LIVEKIT_URL: 'wss://lk', LIVEKIT_API_KEY: 'k' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://matrix.example.com/livekit/get_token',
      },
    ]);
  });
});

describe('well-known LiveKit gate truthiness leftovers TOKENMAXX after #83', () => {
  it('treats whitespace-only LIVEKIT_URL as truthy gate (non-empty string)', async () => {
    // JS `&&` treats '   ' as truthy — document existing behavior
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({ LIVEKIT_URL: '   ', LIVEKIT_API_KEY: 'k' })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toEqual([
      {
        type: 'livekit',
        livekit_service_url: 'https://matrix.example.com/livekit/get_token',
      },
    ]);
  });

  it('still omits foci when LIVEKIT_API_KEY is missing even if LIVEKIT_API_SECRET is set', async () => {
    const { body } = await getJson(
      '/.well-known/matrix/client',
      env({
        LIVEKIT_URL: 'wss://livekit.example.com',
        LIVEKIT_API_SECRET: 'secret-only',
      })
    );
    expect(body['org.matrix.msc4143.rtc_foci']).toBeUndefined();
  });
});
