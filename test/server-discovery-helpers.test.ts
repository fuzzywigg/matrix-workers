import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isIPLiteral,
  selectSRVRecord,
  buildServerUrl,
  clearDiscoveryCache,
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

  it('ignores higher-priority groups entirely when a lower priority exists', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const backup: SRVRecord = { priority: 20, weight: 100, port: 8448, target: 'backup.example.com' };
    const primary: SRVRecord = { priority: 0, weight: 1, port: 8448, target: 'primary.example.com' };
    expect(selectSRVRecord([backup, primary]).target).toBe('primary.example.com');
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

  it('keeps host literals including bracketed IPv6', () => {
    expect(
      buildServerUrl({ host: '[2001:db8::1]', port: 8448, tlsHostname: 'example.com' })
    ).toBe('https://[2001:db8::1]:8448');
    expect(buildServerUrl({ host: '1.2.3.4', port: 443, tlsHostname: '1.2.3.4' })).toBe(
      'https://1.2.3.4'
    );
  });
});

describe('isIPLiteral / buildServerUrl edges', () => {
  it('requires non-empty contents inside brackets for IPv6 literals', () => {
    // Regex is /^\[.+\]$/ — empty [] does not match
    expect(isIPLiteral('[]')).toBe(false);
    expect(isIPLiteral('[::]')).toBe(true);
  });

  it('rejects bare IPv6 without brackets', () => {
    expect(isIPLiteral('2001:db8::1')).toBe(false);
  });

  it('rejects bracketed IPv6 with a trailing port suffix', () => {
    // Regex requires the string to end at `]` — host:port forms are not literals here
    expect(isIPLiteral('[::1]:8448')).toBe(false);
  });

  it('includes non-443 ports including 80 and 8448', () => {
    expect(buildServerUrl({ host: 'example.com', port: 80, tlsHostname: 'example.com' })).toBe(
      'https://example.com:80'
    );
  });
});

describe('selectSRVRecord single zero-weight peer', () => {
  it('returns the sole zero-weight record without random selection', () => {
    const only: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'solo.example.com' };
    expect(selectSRVRecord([only]).target).toBe('solo.example.com');
  });
});


describe('server-discovery TOKENMAXX edge paths after #49', () => {
  it('selects the first peer when random hits the exact weight boundary of zero', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const a: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 90, port: 8448, target: 'b.example.com' };
    // total=100, random=0 → random*total=0; first peer with weight>0 when random<=0
    expect(selectSRVRecord([a, b]).target).toBe('a.example.com');
  });
});

describe('server-discovery TOKENMAXX edge paths after #50', () => {
  it('builds URLs from host/port and ignores tlsHostname for the authority', () => {
    expect(
      buildServerUrl({ host: 'a.example.com', port: 8448, tlsHostname: 'b.example.com' })
    ).toBe('https://a.example.com:8448');
  });

  it('detects loopback IPv4 as an IP literal', () => {
    expect(isIPLiteral('127.0.0.1')).toBe(true);
  });

  it('selects the mid-list peer when random hits its cumulative weight boundary', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const a: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 90, port: 8448, target: 'b.example.com' };
    // total=100, random*total=10 → first peer where cumulative >= 10 is a (weight 10)
    expect(selectSRVRecord([a, b]).target).toBe('a.example.com');
  });
});


describe('server-discovery TOKENMAXX edge paths after #52', () => {
  it('throws when selectSRVRecord receives an empty list (fail-closed)', () => {
    expect(() => selectSRVRecord([])).toThrow();
  });

  it('can still select a leading zero-weight peer when random depletes immediately', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const zero: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'zero.example.com' };
    const heavy: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'heavy.example.com' };
    // total=10, random=0; first peer: random -= 0 → 0 <= 0 → returns zero
    expect(selectSRVRecord([zero, heavy]).target).toBe('zero.example.com');
  });

  it('reaches a later nonzero-weight peer when random stays positive past zero-weight', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const zero: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'zero.example.com' };
    const heavy: SRVRecord = { priority: 0, weight: 10, port: 8448, target: 'heavy.example.com' };
    // total=10, random=5; zero subtracts 0; heavy subtracts 10 → selected
    expect(selectSRVRecord([zero, heavy]).target).toBe('heavy.example.com');
  });

  it('treats leading-zero IPv4 octets as literals and rejects trailing-dot forms', () => {
    expect(isIPLiteral('01.02.03.04')).toBe(true);
    expect(isIPLiteral('1.2.3.4.')).toBe(false);
  });

  it('includes non-443 numeric ports verbatim in buildServerUrl', () => {
    expect(buildServerUrl({ host: 'example.com', port: 8448, tlsHostname: 'example.com' })).toBe(
      'https://example.com:8448'
    );
  });
});


describe('clearDiscoveryCache + all-zero SRV weights', () => {
  it('deletes only discovery:{serverName}', async () => {
    const store: Record<string, string> = {
      'discovery:a.example.com': '{"host":"a"}',
      'discovery:b.example.com': '{"host":"b"}',
      'other:a.example.com': 'keep',
    };
    const cache = {
      delete: async (key: string) => {
        delete store[key];
      },
    } as unknown as KVNamespace;
    await clearDiscoveryCache('a.example.com', cache);
    expect(store['discovery:a.example.com']).toBeUndefined();
    expect(store['discovery:b.example.com']).toBe('{"host":"b"}');
    expect(store['other:a.example.com']).toBe('keep');
  });

  it('picks index 0 or last among two weight-0 peers based on Math.random', () => {
    const a: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'a.example.com' };
    const b: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'b.example.com' };
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(selectSRVRecord([a, b]).target).toBe('a.example.com');
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(selectSRVRecord([a, b]).target).toBe('b.example.com');
  });

  it('ignores higher-priority peers when selecting among lowest-priority zero-weight set', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const backup: SRVRecord = { priority: 10, weight: 0, port: 8448, target: 'backup.example.com' };
    const p0: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'p0.example.com' };
    const p1: SRVRecord = { priority: 0, weight: 0, port: 8448, target: 'p1.example.com' };
    expect(selectSRVRecord([backup, p0, p1]).target).toBe('p0.example.com');
  });
});
