import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEY_MAX_STALENESS_MS,
  isKeyTooStale,
  resolveMaxStalenessMs,
} from '../src/services/federation-keys';

describe('DEFAULT_KEY_MAX_STALENESS_MS', () => {
  it('is seven days in milliseconds', () => {
    expect(DEFAULT_KEY_MAX_STALENESS_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('isKeyTooStale', () => {
  const now = 1_700_000_000_000;
  const max = 1_000;

  it('treats missing expiry as not stale', () => {
    expect(isKeyTooStale(null, now, max)).toBe(false);
    expect(isKeyTooStale(undefined, now, max)).toBe(false);
    expect(isKeyTooStale(0, now, max)).toBe(false);
  });

  it('is not stale when still within the grace window', () => {
    expect(isKeyTooStale(now - 500, now, max)).toBe(false);
    expect(isKeyTooStale(now + 10_000, now, max)).toBe(false);
  });

  it('is stale only after maxStalenessMs past valid_until', () => {
    expect(isKeyTooStale(now - max, now, max)).toBe(false); // equality: not > max
    expect(isKeyTooStale(now - max - 1, now, max)).toBe(true);
  });

  it('uses the default max staleness when omitted', () => {
    expect(isKeyTooStale(now - DEFAULT_KEY_MAX_STALENESS_MS - 1, now)).toBe(true);
    expect(isKeyTooStale(now - DEFAULT_KEY_MAX_STALENESS_MS + 1, now)).toBe(false);
  });
});

describe('resolveMaxStalenessMs', () => {
  it('falls back to the default when env is missing or empty', () => {
    expect(resolveMaxStalenessMs()).toBe(DEFAULT_KEY_MAX_STALENESS_MS);
    expect(resolveMaxStalenessMs({})).toBe(DEFAULT_KEY_MAX_STALENESS_MS);
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
  });

  it('parses a positive integer override', () => {
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '3600000' })).toBe(3_600_000);
  });

  it('rejects zero, negative, and non-numeric values', () => {
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '0' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '-5' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: 'nope' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
  });

  it('parses leading-plus and float prefixes via parseInt', () => {
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '+2500' })).toBe(2500);
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '3600.9' })).toBe(3600);
  });

  it('accepts large positive overrides', () => {
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '86400000000' })).toBe(
      86_400_000_000
    );
  });

  it('rejects whitespace-only and hex-looking non-decimal strings', () => {
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '   ' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
    // parseInt('0x10') === 0 → rejected by > 0 check
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '0x10' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
  });
});

describe('isKeyTooStale future-dated keys', () => {
  it('never treats a future valid_until as stale', () => {
    const now = 1_700_000_000_000;
    expect(isKeyTooStale(now + 365 * 24 * 60 * 60 * 1000, now, 1)).toBe(false);
  });
});

describe('isKeyTooStale / resolveMaxStalenessMs boundary edges', () => {
  it('is not stale when now equals valid_until', () => {
    const now = 1_700_000_000_000;
    expect(isKeyTooStale(now, now, 1_000)).toBe(false);
  });

  it('treats negative valid_until as truthy and evaluates staleness', () => {
    const now = 1_000;
    expect(isKeyTooStale(-1, now, 10)).toBe(true);
  });

  it('rejects scientific-notation env strings that parseInt truncates to 0-ish invalid', () => {
    // parseInt('1e6', 10) === 1 → accepted as 1ms override
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: '1e6' })).toBe(1);
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: 'NaN' })).toBe(
      DEFAULT_KEY_MAX_STALENESS_MS
    );
  });

  it('treats zero maxStalenessMs as any past expiry being stale', () => {
    // Env resolver rejects "0", but the helper still accepts an explicit 0
    expect(isKeyTooStale(1000, 1001, 0)).toBe(true);
    expect(isKeyTooStale(1000, 1000, 0)).toBe(false);
  });

  it('parses leading-whitespace env overrides via parseInt', () => {
    expect(resolveMaxStalenessMs({ FEDERATION_KEY_MAX_STALENESS_MS: ' 5000' })).toBe(5000);
  });
});
