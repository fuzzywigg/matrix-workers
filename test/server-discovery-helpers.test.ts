import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isIPLiteral,
  selectSRVRecord,
  type SRVRecord,
} from '../src/services/server-discovery';

describe('isIPLiteral', () => {
  it('detects IPv4 and bracketed IPv6', () => {
    expect(isIPLiteral('1.2.3.4')).toBe(true);
    expect(isIPLiteral('[::1]')).toBe(true);
    expect(isIPLiteral('matrix.example.com')).toBe(false);
    expect(isIPLiteral('::1')).toBe(false);
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

  it('picks among zero-weight peers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const a: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'b.example.com' };
    expect(selectSRVRecord([a, b]).target).toBe('b.example.com');
  });
});
