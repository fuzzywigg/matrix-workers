import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getActorIp, logAdminAction } from '../src/services/admin-audit';
import type { Context } from 'hono';
import type { AppEnv } from '../src/types';

const NOW = 1_700_000_000_000;

function makeContext(
  headers: Record<string, string>,
  env: Partial<AppEnv['Bindings']> = {},
  userId?: string
): Context<AppEnv> {
  return {
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
    env,
    get: (key: string) => (key === 'userId' ? userId : undefined),
  } as unknown as Context<AppEnv>;
}

function createAuditDb() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO admin_audit_log')) {
                inserts.push(args);
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { inserts: unknown[][] };
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

  it('ignores blank CF-Connecting-IP and falls through', () => {
    // Empty string is falsy → treated as absent
    expect(getActorIp(makeContext({ 'CF-Connecting-IP': '' }))).toBeNull();
  });

  it('returns null for blank XFF first hop when opted in', () => {
    expect(
      getActorIp(
        makeContext({ 'X-Forwarded-For': '  , 10.0.0.1' }, { TRUST_FORWARDED_FOR: 'true' })
      )
    ).toBeNull();
  });
});


describe('getActorIp TOKENMAXX edge paths after #49', () => {
  it('requires exact lowercase true for TRUST_FORWARDED_FOR', () => {
    expect(
      getActorIp(makeContext({ 'X-Forwarded-For': '198.51.100.1' }, { TRUST_FORWARDED_FOR: 'TRUE' }))
    ).toBeNull();
    expect(
      getActorIp(makeContext({ 'X-Forwarded-For': '198.51.100.1' }, { TRUST_FORWARDED_FOR: '1' }))
    ).toBeNull();
  });

  it('falls through blank CF-Connecting-IP to trusted XFF', () => {
    expect(
      getActorIp(
        makeContext(
          { 'CF-Connecting-IP': '', 'X-Forwarded-For': '198.51.100.7' },
          { TRUST_FORWARDED_FOR: 'true' }
        )
      )
    ).toBe('198.51.100.7');
  });
});

describe('getActorIp TOKENMAXX edge paths after #50', () => {
  it('returns IPv6 CF-Connecting-IP values as-is', () => {
    expect(
      getActorIp(makeContext({ 'CF-Connecting-IP': '2001:db8::1' }))
    ).toBe('2001:db8::1');
  });

  it('returns null when TRUST_FORWARDED_FOR is true but XFF is absent', () => {
    expect(getActorIp(makeContext({}, { TRUST_FORWARDED_FOR: 'true' }))).toBeNull();
  });
});

describe('logAdminAction clock-pinned INSERT ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips insert when userId is absent', async () => {
    const db = createAuditDb();
    await logAdminAction(
      makeContext({}, { DB: db }),
      { action: 'user.deactivate', target: '@u:ex.com' }
    );
    expect(db.inserts).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it('pins INSERT ts to Date.now() and defaults success=1 / null target+details', async () => {
    const db = createAuditDb();
    await logAdminAction(
      makeContext(
        { 'CF-Connecting-IP': '203.0.113.9' },
        { DB: db },
        '@admin:ex.com'
      ),
      { action: 'user.create' }
    );
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toEqual([
      NOW,
      '@admin:ex.com',
      'user.create',
      null,
      '203.0.113.9',
      1,
      null,
    ]);
  });

  it('stores success=0 and JSON-stringified details; mid-flight clock advance updates ts', async () => {
    const db = createAuditDb();
    vi.setSystemTime(NOW + 5);
    await logAdminAction(
      makeContext({}, { DB: db, TRUST_FORWARDED_FOR: 'true' }, '@admin:ex.com'),
      {
        action: 'user.ban',
        target: '@bad:ex.com',
        success: false,
        details: { reason: 'spam', score: 1 },
      }
    );
    expect(db.inserts[0]).toEqual([
      NOW + 5,
      '@admin:ex.com',
      'user.ban',
      '@bad:ex.com',
      null,
      0,
      JSON.stringify({ reason: 'spam', score: 1 }),
    ]);
  });

  it('does not throw when D1 insert fails', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error('d1 down');
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(
      logAdminAction(
        makeContext({}, { DB: db }, '@admin:ex.com'),
        { action: 'x' }
      )
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('treats success:true and omitted success the same (bind 1)', async () => {
    const db = createAuditDb();
    await logAdminAction(
      makeContext({}, { DB: db }, '@a:ex.com'),
      { action: 'a', success: true }
    );
    await logAdminAction(
      makeContext({}, { DB: db }, '@a:ex.com'),
      { action: 'b' }
    );
    expect(db.inserts[0][5]).toBe(1);
    expect(db.inserts[1][5]).toBe(1);
  });
});
