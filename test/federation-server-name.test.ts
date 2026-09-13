import { describe, it, expect } from 'vitest';
import { isValidServerName } from '../src/api/federation';

describe('isValidServerName (federation notary gate)', () => {
  it('accepts public hostnames and host:port', () => {
    expect(isValidServerName('matrix.example.com')).toBe(true);
    expect(isValidServerName('matrix.org')).toBe(true);
    expect(isValidServerName('matrix.example.com:8448')).toBe(true);
  });

  it('rejects empty and overlong names', () => {
    expect(isValidServerName('')).toBe(false);
    expect(isValidServerName('a'.repeat(256))).toBe(false);
  });

  it('rejects private IPs and localhost', () => {
    expect(isValidServerName('127.0.0.1')).toBe(false);
    expect(isValidServerName('10.0.0.1')).toBe(false);
    expect(isValidServerName('192.168.1.1')).toBe(false);
    expect(isValidServerName('localhost')).toBe(false);
  });

  it('rejects blocked ports', () => {
    expect(isValidServerName('evil.example.com:22')).toBe(false);
    expect(isValidServerName('evil.example.com:3306')).toBe(false);
    expect(isValidServerName('evil.example.com:6379')).toBe(false);
    expect(isValidServerName('evil.example.com:5432')).toBe(false);
  });

  it('rejects link-local, CGNAT-adjacent private ranges, and 0.x', () => {
    expect(isValidServerName('169.254.169.254')).toBe(false);
    expect(isValidServerName('172.16.0.1')).toBe(false);
    expect(isValidServerName('172.31.255.255')).toBe(false);
    expect(isValidServerName('0.0.0.0')).toBe(false);
  });

  it('rejects .local / .internal / metadata hostnames', () => {
    expect(isValidServerName('printer.local')).toBe(false);
    expect(isValidServerName('db.internal')).toBe(false);
    expect(isValidServerName('metadata')).toBe(false);
    expect(isValidServerName('metadata.google.internal')).toBe(false);
  });

  it('rejects IPv6 loopback and unique-local literals', () => {
    expect(isValidServerName('[::1]')).toBe(false);
    expect(isValidServerName('[fc00::1]')).toBe(false);
    expect(isValidServerName('[fe80::1]')).toBe(false);
  });

  it('accepts public host:8448 and multi-label domains', () => {
    expect(isValidServerName('matrix.org:8448')).toBe(true);
    expect(isValidServerName('a.b.c.example.com')).toBe(true);
  });

  it('rejects additional internal service ports used in notary queries', () => {
    expect(isValidServerName('evil.example.com:445')).toBe(false);
    expect(isValidServerName('evil.example.com:9200')).toBe(false);
    expect(isValidServerName('evil.example.com:27017')).toBe(false);
    expect(isValidServerName('evil.example.com:3389')).toBe(false);
  });

  it('rejects IPv6 documentation, multicast, and site-local literals', () => {
    expect(isValidServerName('[2001:db8::1]')).toBe(false);
    expect(isValidServerName('[ff02::1]')).toBe(false);
    expect(isValidServerName('[fec0::1]')).toBe(false);
  });

  it('rejects kubernetes.default and localhost.localdomain', () => {
    expect(isValidServerName('kubernetes.default')).toBe(false);
    expect(isValidServerName('localhost.localdomain')).toBe(false);
  });

  it('rejects IPv4-mapped loopback literals', () => {
    // WHATWG URL normalizes dotted mapped form to hex
    expect(isValidServerName('[::ffff:127.0.0.1]')).toBe(false);
    expect(isValidServerName('[::ffff:7f00:1]')).toBe(false);
  });

  it('accepts public host on default Matrix federation port only when SSRF-safe', () => {
    expect(isValidServerName('matrix.org:443')).toBe(true);
    expect(isValidServerName('203.0.113.10:8448')).toBe(true);
  });

  it('rejects subdomains of localhost via hostname suffix matching', () => {
    expect(isValidServerName('evil.localhost')).toBe(false);
  });

  it('accepts public IPv6 literals and names at the 255-char length boundary', () => {
    expect(isValidServerName('[2606:4700:4700::1111]')).toBe(true);
    expect(isValidServerName('a'.repeat(255))).toBe(true);
    expect(isValidServerName('a'.repeat(256))).toBe(false);
  });

  it('rejects remaining internal service ports mirrored from url-validator', () => {
    for (const port of [23, 135, 139, 5900]) {
      expect(isValidServerName(`evil.example.com:${port}`)).toBe(false);
    }
  });

  it('rejects exact internal / full k8s / ip6-localhost hostnames', () => {
    expect(isValidServerName('internal')).toBe(false);
    expect(isValidServerName('kubernetes.default.svc.cluster.local')).toBe(false);
    expect(isValidServerName('ip6-localhost')).toBe(false);
  });

  it('allows public 172.32 and denies broadcast / 172.16 boundary', () => {
    expect(isValidServerName('172.32.0.1')).toBe(true);
    expect(isValidServerName('172.15.0.1')).toBe(true);
    expect(isValidServerName('172.16.0.0')).toBe(false);
    expect(isValidServerName('255.255.255.255')).toBe(false);
  });

  it('rejects uppercase LOCALHOST via URL hostname lowercasing', () => {
    expect(isValidServerName('LOCALHOST')).toBe(false);
  });

  it('rejects fea/fee IPv6 site/link-local prefixes', () => {
    expect(isValidServerName('[fea0::1]')).toBe(false);
    expect(isValidServerName('[fee0::1]')).toBe(false);
  });
});
