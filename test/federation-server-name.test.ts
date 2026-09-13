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
  });
});
