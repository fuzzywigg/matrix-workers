import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isIPLiteral,
  selectSRVRecord,
  buildServerUrl,
  type SRVRecord,
} from '../src/services/server-discovery';

describe('isIPLiteral', () => {
  it('detects IPv4 and bracketed IPv6', () => {
    expect(isIPLiteral('1.2.3.4')).toBe(true);
    expect(isIPLiteral('[::1]')).toBe(true);
    expect(isIPLiteral('matrix.example.com')).toBe(false);
    expect(isIPLiteral('::1')).toBe(false);
  });

  it('accepts loose IPv4-shaped strings (current regex)', () => {
    // Intentionally permissive — discovery still validates via validateUrl later
    expect(isIPLiteral('999.999.999.999')).toBe(true);
    expect(isIPLiteral('1.2.3')).toBe(false);
    expect(isIPLiteral('1.2.3.4.5')).toBe(false);
  });
});

describe('selectSRVRecord', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the only record', () => {
    const only: SRVRecord = { priority: 10, weight: 5, port: 8448, target: 'a.example.com' };
    expect(selectSRVRecord([only])).toBe(only);
  });

  it('prefers lower priority', () => {
    const low: SRVRecord = { priority: 5, weight: 1, port: 8448, target: 'low.example.com' };
    const high: SRVRecord = { priority: 10, weight: 100, port: 8448, target: 'high.example.com' };
    expect(selectSRVRecord([high, low]).target).toBe('low.example.com');
  });

  it('uses weight among same priority', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const a: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 90, port: 8448, target: 'b.example.com' };
    expect(selectSRVRecord([a, b]).target).toBe('a.example.com');
  });

  it('selects the heavier peer when random is near 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const a: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 90, port: 8448, target: 'b.example.com' };
    expect(selectSRVRecord([a, b]).target).toBe('b.example.com');
  });

  it('picks among zero-weight peers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const a: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'b.example.com' };
    expect(selectSRVRecord([a, b]).target).toBe('b.example.com');
  });

  it('chooses among three same-priority weighted peers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const a: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'b.example.com' };
    const c: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'c.example.com' };
    // totalWeight=30, random=15 → subtract a(10)=5, subtract b(10)=-5 → b
    expect(selectSRVRecord([a, b, c]).target).toBe('b.example.com');
  });
});

describe('buildServerUrl', () => {
  it('omits default https port 443', () => {
    expect(buildServerUrl({ host: 'example.com', port: 443, tlsHostname: 'example.com' })).toBe(
      'https://example.com'
    );
  });

  it('includes non-default ports such as 8448', () => {
    expect(buildServerUrl({ host: 'example.com', port: 8448, tlsHostname: 'example.com' })).toBe(
      'https://example.com:8448'
    );
  });
});
