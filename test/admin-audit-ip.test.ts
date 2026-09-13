import { describe, it, expect } from 'vitest';
import { getActorIp } from '../src/services/admin-audit';
import type { Context } from 'hono';
import type { AppEnv } from '../src/types';

function makeContext(
  headers: Record<string, string>,
  env: Partial<AppEnv['Bindings']> = {}
): Context<AppEnv> {
  return {
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
    env,
  } as unknown as Context<AppEnv>;
}

describe('getActorIp', () => {
  it('prefers CF-Connecting-IP', () => {
    expect(
      getActorIp(
        makeContext(
          { 'CF-Connecting-IP': '203.0.113.10', 'X-Forwarded-For': '198.51.100.1' },
          { TRUST_FORWARDED_FOR: 'true' }
        )
      )
    ).toBe('203.0.113.10');
  });

  it('ignores X-Forwarded-For unless TRUST_FORWARDED_FOR is enabled', () => {
    expect(getActorIp(makeContext({ 'X-Forwarded-For': '198.51.100.1' }))).toBeNull();
    expect(
      getActorIp(makeContext({ 'X-Forwarded-For': '198.51.100.1' }, { TRUST_FORWARDED_FOR: 'false' }))
    ).toBeNull();
  });

  it('uses the first XFF hop when opted in', () => {
    expect(
      getActorIp(
        makeContext(
          { 'X-Forwarded-For': ' 198.51.100.9 , 10.0.0.1' },
          { TRUST_FORWARDED_FOR: 'true' }
        )
      )
    ).toBe('198.51.100.9');
  });

  it('returns null when no trusted IP source is available', () => {
    expect(getActorIp(makeContext({}, { TRUST_FORWARDED_FOR: 'true' }))).toBeNull();
  });
});
