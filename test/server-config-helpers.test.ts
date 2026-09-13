import { describe, it, expect } from 'vitest';
import { buildServerUrl } from '../src/services/server-discovery';
import { getStunServers, isTurnConfigured, getTurnStatus } from '../src/services/turn';
import { getLiveKitConfig } from '../src/services/livekit';
import { isCallsConfigured } from '../src/services/cloudflare-calls';
import type { Env } from '../src/types';

function env(partial: Partial<Env> = {}): Env {
  return partial as Env;
}

describe('buildServerUrl', () => {
  it('omits the port for HTTPS default 443', () => {
    expect(
      buildServerUrl({ host: 'matrix.example.com', port: 443, tlsHostname: 'matrix.example.com' })
    ).toBe('https://matrix.example.com');
  });

  it('includes non-default ports', () => {
    expect(
      buildServerUrl({ host: 'matrix.example.com', port: 8448, tlsHostname: 'matrix.example.com' })
    ).toBe('https://matrix.example.com:8448');
  });
});

describe('TURN / Calls / LiveKit config helpers', () => {
  it('exposes Cloudflare STUN servers without credentials', () => {
    const stun = getStunServers();
    expect(stun.username).toBe('');
    expect(stun.password).toBe('');
    expect(stun.uris.some((u) => u.startsWith('stun:'))).toBe(true);
    expect(stun.ttl).toBeGreaterThan(0);
  });

  it('detects TURN configuration and redacts key id in status', () => {
    expect(isTurnConfigured(env())).toBe(false);
    expect(getTurnStatus(env()).configured).toBe(false);

    const configured = env({ TURN_KEY_ID: 'abcdefghijklmnop', TURN_API_TOKEN: 'tok' });
    expect(isTurnConfigured(configured)).toBe(true);
    expect(getTurnStatus(configured)).toEqual({
      configured: true,
      keyId: 'abcdefgh...',
    });
  });

  it('requires all LiveKit fields before returning config', () => {
    expect(getLiveKitConfig(env({ LIVEKIT_API_KEY: 'k' }))).toBeNull();
    expect(
      getLiveKitConfig(
        env({
          LIVEKIT_API_KEY: 'k',
          LIVEKIT_API_SECRET: 's',
          LIVEKIT_URL: 'wss://livekit.example.com',
        })
      )
    ).toEqual({
      apiKey: 'k',
      apiSecret: 's',
      wsUrl: 'wss://livekit.example.com',
    });
  });

  it('detects Cloudflare Calls configuration', () => {
    expect(isCallsConfigured(env())).toBe(false);
    expect(isCallsConfigured(env({ CALLS_APP_ID: 'app', CALLS_APP_SECRET: 'sec' }))).toBe(true);
  });

  it('requires both Calls id and secret', () => {
    expect(isCallsConfigured(env({ CALLS_APP_ID: 'app' }))).toBe(false);
    expect(isCallsConfigured(env({ CALLS_APP_SECRET: 'sec' }))).toBe(false);
  });

  it('requires both TURN key id and token', () => {
    expect(isTurnConfigured(env({ TURN_KEY_ID: 'abcdefghijklmnop' }))).toBe(false);
    expect(isTurnConfigured(env({ TURN_API_TOKEN: 'tok' }))).toBe(false);
  });

  it('omits keyId from TURN status when unset', () => {
    expect(getTurnStatus(env())).toEqual({ configured: false, keyId: undefined });
  });
});
