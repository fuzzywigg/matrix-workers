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
});
