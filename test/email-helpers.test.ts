import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVerificationSession,
  generateSessionId,
  generateVerificationToken,
  getValidatedSession,
  sendVerificationEmail,
  validateEmailToken,
} from '../src/services/email';
import type { Env } from '../src/types';

type SessionRow = {
  session_id: string;
  email: string;
  user_id: string | null;
  client_secret: string;
  token: string;
  send_attempt: number;
  validated: number;
  created_at: number;
  expires_at: number;
  validated_at?: number | null;
};

/** Minimal D1 stand-in for email_verification_sessions paths. */
function createEmailDb(store = new Map<string, SessionRow>()) {
  return {
    store,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                const [email, clientSecret] = args as [string, string];
                const rows = [...store.values()]
                  .filter((r) => r.email === email && r.client_secret === clientSecret)
                  .sort((a, b) => b.created_at - a.created_at);
                return (rows[0] as T) ?? null;
              }
              if (sql.includes('WHERE session_id = ? AND validated = 1')) {
                const [sessionId] = args as [string];
                const row = store.get(sessionId);
                if (!row || row.validated !== 1) return null;
                return {
                  email: row.email,
                  user_id: row.user_id,
                  client_secret: row.client_secret,
                  validated: row.validated,
                } as T;
              }
              if (sql.includes('WHERE session_id = ?')) {
                const [sessionId] = args as [string];
                return (store.get(sessionId) as T) ?? null;
              }
              return null;
            },
            async run() {
              if (sql.includes('DELETE FROM email_verification_sessions')) {
                const [sessionId] = args as [string];
                store.delete(sessionId);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO email_verification_sessions')) {
                const [
                  sessionId,
                  email,
                  userId,
                  clientSecret,
                  token,
                  sendAttempt,
                  createdAt,
                  expiresAt,
                ] = args as [
                  string,
                  string,
                  string | null,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
                store.set(sessionId, {
                  session_id: sessionId,
                  email,
                  user_id: userId,
                  client_secret: clientSecret,
                  token,
                  send_attempt: sendAttempt,
                  validated: 0,
                  created_at: createdAt,
                  expires_at: expiresAt,
                  validated_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE email_verification_sessions')) {
                const [validatedAt, sessionId] = args as [number, string];
                const row = store.get(sessionId);
                if (row) {
                  row.validated = 1;
                  row.validated_at = validatedAt;
                }
                return { meta: { changes: row ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: Map<string, SessionRow> };
}

function throwingDb(method: 'first' | 'run' = 'first'): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              if (method === 'first') throw new Error('db first boom');
              return null;
            },
            async run() {
              throw new Error('db run boom');
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('email helpers TOKENMAXX edge paths after #50', () => {
  it('generates a 6-digit verification code in the 100000–999999 range', () => {
    const code = generateVerificationToken();
    expect(code).toMatch(/^\d{6}$/);
    const n = Number(code);
    expect(n).toBeGreaterThanOrEqual(100000);
    expect(n).toBeLessThanOrEqual(999999);
  });

  it('usually produces distinct verification codes across calls', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateVerificationToken()));
    expect(codes.size).toBeGreaterThan(1);
  });

  it('generates 32-char lowercase hex session ids', async () => {
    const id = await generateSessionId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('usually produces distinct session ids across calls', async () => {
    const a = await generateSessionId();
    const b = await generateSessionId();
    expect(a).not.toBe(b);
  });
});

describe('sendVerificationEmail', () => {
  it('fails when EMAIL binding is missing', async () => {
    const result = await sendVerificationEmail({} as Env, 'a@b.c', '123456', 'example.com');
    expect(result).toEqual({ success: false, error: 'Email service not configured' });
  });

  it('uses EMAIL_FROM when set and includes token + serverName in body', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-1' }));
    const env = {
      EMAIL_FROM: 'verify@matrix.example.com',
      EMAIL: { send },
    } as unknown as Env;

    const result = await sendVerificationEmail(env, 'user@ex.com', '654321', 'matrix.example.com');
    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledOnce();
    const args = send.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(args.from).toBe('verify@matrix.example.com');
    expect(args.to).toBe('user@ex.com');
    expect(args.subject).toBe('Your matrix.example.com verification code');
    expect(args.html).toContain('654321');
    expect(args.html).toContain('matrix.example.com');
    expect(args.text).toContain('654321');
    expect(args.text).toContain('matrix.example.com');
  });

  it('defaults from to noreply@serverName when EMAIL_FROM unset', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-2' }));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '111111', 'homeserver.test');
    expect(send.mock.calls[0][0].from).toBe('noreply@homeserver.test');
  });

  it('returns Error.message when EMAIL.send throws an Error', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw new Error('smtp down');
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex')).toEqual({
      success: false,
      error: 'smtp down',
    });
  });

  it('returns generic failure when EMAIL.send throws a non-Error', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw 'nope';
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex')).toEqual({
      success: false,
      error: 'Failed to send email',
    });
  });
});

describe('createVerificationSession (clock-pinned)', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts a new session with expires_at = now + 24h and null userId', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1);
    expect(result).toMatchObject({ sessionId: expect.any(String), token: expect.stringMatching(/^\d{6}$/) });
    if ('error' in result) throw new Error(result.error);

    const row = [...db.store.values()][0];
    expect(row.email).toBe('a@b.c');
    expect(row.client_secret).toBe('secret');
    expect(row.user_id).toBeNull();
    expect(row.send_attempt).toBe(1);
    expect(row.validated).toBe(0);
    expect(row.created_at).toBe(NOW);
    expect(row.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(row.session_id).toBe(result.sessionId);
    expect(row.token).toBe(result.token);
  });

  it('stores optional userId when provided', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1, '@alice:ex.com');
    expect('sessionId' in result).toBe(true);
    expect([...db.store.values()][0].user_id).toBe('@alice:ex.com');
  });

  it('rejects when an existing session is already validated', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 1,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      error: 'Email already validated for this session',
    });
  });

  it('returns existing sessionId with empty token on same/lower sendAttempt retry', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 3,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 3)).toEqual({
      sessionId: 'old',
      token: '',
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      sessionId: 'old',
      token: '',
    });
    expect(db.store.size).toBe(1);
  });

  it('deletes old session and inserts a fresh one on higher sendAttempt', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2);
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(result.sessionId).not.toBe('old');
    expect(result.token).toMatch(/^\d{6}$/);
    expect(db.store.has('old')).toBe(false);
    expect(db.store.size).toBe(1);
    expect([...db.store.values()][0].send_attempt).toBe(2);
  });

  it('returns error when DB first() throws', async () => {
    expect(await createVerificationSession(throwingDb('first'), 'a@b.c', 's', 1)).toEqual({
      error: 'Failed to create verification session',
    });
  });

  it('returns error when DB run() throws on insert', async () => {
    expect(await createVerificationSession(throwingDb('run'), 'a@b.c', 's', 1)).toEqual({
      error: 'Failed to create verification session',
    });
  });
});

describe('validateEmailToken (clock-pinned)', () => {
  const NOW = 1_700_000_100_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(
    overrides: Partial<SessionRow> = {}
  ): D1Database & { store: Map<string, SessionRow> } {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
      ...overrides,
    });
    return db;
  }

  it('returns Session not found for unknown sessionId', async () => {
    expect(await validateEmailToken(createEmailDb(), 'missing', 's', 't')).toEqual({
      success: false,
      error: 'Session not found',
    });
  });

  it('short-circuits success when already validated without checking token', async () => {
    const db = seed({ validated: 1, token: 'other' });
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
  });

  it('treats expires_at === now as still valid (strict >)', async () => {
    const db = seed({ expires_at: NOW });
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated).toBe(1);
    expect(db.store.get('sid')!.validated_at).toBe(NOW);
  });

  it('rejects just after expiry', async () => {
    const db = seed({ expires_at: NOW - 1 });
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({
      success: false,
      error: 'Session expired',
    });
  });

  it('rejects mismatched client_secret', async () => {
    expect(await validateEmailToken(seed(), 'sid', 'wrong', '654321')).toEqual({
      success: false,
      error: 'Invalid client_secret',
    });
  });

  it('rejects mismatched token', async () => {
    expect(await validateEmailToken(seed(), 'sid', 'secret', '000000')).toEqual({
      success: false,
      error: 'Invalid token',
    });
  });

  it('marks validated with validated_at pinned to now on success', async () => {
    const db = seed();
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')).toMatchObject({ validated: 1, validated_at: NOW });
  });

  it('returns Validation failed when DB throws', async () => {
    expect(await validateEmailToken(throwingDb('first'), 'sid', 's', 't')).toEqual({
      success: false,
      error: 'Validation failed',
    });
  });
});

describe('getValidatedSession', () => {
  it('returns null when session missing or not validated', async () => {
    const db = createEmailDb();
    expect(await getValidatedSession(db, 'missing', 'secret')).toBeNull();

    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 0,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toBeNull();
  });

  it('returns null when client_secret mismatches a validated session', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'wrong')).toBeNull();
  });

  it('returns email and userId when validated', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: '@u:ex.com',
    });
  });

  it('omits userId when user_id is null', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: undefined,
    });
  });
});

describe('email helpers TOKENMAXX HEAVY crypto pinning after #89', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps getRandomValues(0) → verification token "100000"', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 0;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
  });

  it('maps getRandomValues(899999) → verification token "999999"', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 899_999;
      return arr;
    });
    expect(generateVerificationToken()).toBe('999999');
  });

  it('wraps getRandomValues(900000) via % 900000 back to "100000"', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 900_000;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
  });

  it('wraps getRandomValues(1_800_000) → "100000" and 900_001 → "100001"', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    spy.mockImplementationOnce(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 1_800_000;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
    spy.mockImplementationOnce(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 900_001;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100001');
  });

  it('maps all-zero session bytes to 32 hex zeros', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) arr.fill(0);
      return arr;
    });
    expect(await generateSessionId()).toBe('0'.repeat(32));
  });

  it('maps all-0xff session bytes to 32 hex "ff" chars', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) arr.fill(0xff);
      return arr;
    });
    expect(await generateSessionId()).toBe('ff'.repeat(16));
  });

  it('zero-pads single-nibble session bytes (0x0a → "0a")', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) {
        for (let i = 0; i < arr.length; i++) arr[i] = 0x0a;
      }
      return arr;
    });
    expect(await generateSessionId()).toBe('0a'.repeat(16));
  });

  it('encodes ascending session bytes as contiguous lowercase hex', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) {
        for (let i = 0; i < arr.length; i++) arr[i] = i;
      }
      return arr;
    });
    expect(await generateSessionId()).toBe('000102030405060708090a0b0c0d0e0f');
  });
});

describe('sendVerificationEmail TOKENMAXX HEAVY body/from edges after #89', () => {
  it('treats empty-string EMAIL_FROM as falsy and falls back to noreply@serverName', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-empty-from' }));
    const env = {
      EMAIL_FROM: '',
      EMAIL: { send },
    } as unknown as Env;
    await sendVerificationEmail(env, 'user@ex.com', '424242', 'matrix.fuzzywigg.com');
    expect(send.mock.calls[0][0].from).toBe('noreply@matrix.fuzzywigg.com');
  });

  it('pins exact subject / html / text copy including 24h expiry wording', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-copy' }));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '777777', 'homeserver.test');
    const args = send.mock.calls[0][0] as {
      subject: string;
      html: string;
      text: string;
      from: string;
      to: string;
    };
    expect(args.subject).toBe('Your homeserver.test verification code');
    expect(args.from).toBe('noreply@homeserver.test');
    expect(args.to).toBe('u@ex.com');
    expect(args.html).toContain('<div class="code">777777</div>');
    expect(args.html).toContain('Your verification code for homeserver.test is:');
    expect(args.html).toContain('This code will expire in 24 hours.');
    expect(args.html).toContain('This email was sent from homeserver.test');
    expect(args.html).toContain("If you didn't request this code, you can safely ignore this email.");
    expect(args.text).toContain('Your verification code for homeserver.test is: 777777');
    expect(args.text).toContain('This code will expire in 24 hours.');
    expect(args.text).toContain('This email was sent from homeserver.test');
    expect(args.text).toContain('Email Verification');
  });

  it('interpolates unusual serverName characters into subject and bodies', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-weird' }));
    const env = {
      EMAIL_FROM: 'from@custom.example',
      EMAIL: { send },
    } as unknown as Env;
    await sendVerificationEmail(env, 'to@ex.com', '000001', 'srv:with/slash');
    const args = send.mock.calls[0][0] as { subject: string; html: string; text: string; from: string };
    expect(args.from).toBe('from@custom.example');
    expect(args.subject).toBe('Your srv:with/slash verification code');
    expect(args.html).toContain('srv:with/slash');
    expect(args.text).toContain('000001');
  });
});

describe('createVerificationSession TOKENMAXX HEAVY session edges after #89', () => {
  const NOW = 1_700_000_200_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats same email + different client_secret as independent sessions', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, 'a@b.c', 'secret-a', 1);
    const b = await createVerificationSession(db, 'a@b.c', 'secret-b', 1);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected error');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('treats different email + same client_secret as independent sessions', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, 'one@ex.com', 'shared', 1);
    const b = await createVerificationSession(db, 'two@ex.com', 'shared', 1);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected error');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('ORDER BY created_at DESC picks newest row for retry / validated checks', async () => {
    const db = createEmailDb();
    db.store.set('older', {
      session_id: 'older',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 5000,
      expires_at: NOW + 1000,
    });
    db.store.set('newer', {
      session_id: 'newer',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '222222',
      send_attempt: 5,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    // sendAttempt 5 matches newest → retry empty token
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 5)).toEqual({
      sessionId: 'newer',
      token: '',
    });
    // mark newest validated → reject even though older is not validated
    db.store.get('newer')!.validated = 1;
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 6)).toEqual({
      error: 'Email already validated for this session',
    });
  });

  it('send_attempt 0 existing + sendAttempt 0 is a retry (empty token)', async () => {
    const db = createEmailDb();
    db.store.set('z', {
      session_id: 'z',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '999999',
      send_attempt: 0,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 0)).toEqual({
      sessionId: 'z',
      token: '',
    });
    expect(db.store.size).toBe(1);
  });

  it('sendAttempt === existing.send_attempt + 1 deletes old and inserts fresh token', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 4,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 5);
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(result.sessionId).not.toBe('old');
    expect(result.token).toMatch(/^\d{6}$/);
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBe(5);
    expect([...db.store.values()][0].token).toBe(result.token);
  });

  it('stores empty-string userId as null via userId || null', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1, '');
    expect('sessionId' in result).toBe(true);
    expect([...db.store.values()][0].user_id).toBeNull();
  });

  it('returns error when DELETE throws after higher sendAttempt', async () => {
    const store = new Map<string, SessionRow>();
    store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                  return {
                    session_id: 'old',
                    send_attempt: 1,
                    validated: 0,
                  } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM email_verification_sessions')) {
                  throw new Error('delete boom');
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      error: 'Failed to create verification session',
    });
  });

  it('pins expires_at exactly 24h ahead on fresh insert after delete path', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 999,
      expires_at: NOW + 1,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2, '@bob:ex.com');
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    const row = [...db.store.values()][0];
    expect(row.created_at).toBe(NOW);
    expect(row.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(row.user_id).toBe('@bob:ex.com');
    expect(row.validated).toBe(0);
  });
});

describe('validateEmailToken TOKENMAXX HEAVY error-precedence after #89', () => {
  const NOW = 1_700_000_300_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(
    overrides: Partial<SessionRow> = {}
  ): D1Database & { store: Map<string, SessionRow> } {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
      ...overrides,
    });
    return db;
  }

  it('expired + wrong client_secret → Session expired (expiry before secret)', async () => {
    expect(
      await validateEmailToken(seed({ expires_at: NOW - 1 }), 'sid', 'wrong', '654321')
    ).toEqual({ success: false, error: 'Session expired' });
  });

  it('expired + wrong token → Session expired (expiry before token)', async () => {
    expect(
      await validateEmailToken(seed({ expires_at: NOW - 1 }), 'sid', 'secret', '000000')
    ).toEqual({ success: false, error: 'Session expired' });
  });

  it('valid expiry + wrong secret + wrong token → Invalid client_secret (secret before token)', async () => {
    expect(await validateEmailToken(seed(), 'sid', 'wrong', '000000')).toEqual({
      success: false,
      error: 'Invalid client_secret',
    });
  });

  it('already validated short-circuits success without UPDATE even when expired', async () => {
    const db = seed({ validated: 1, expires_at: NOW - 1, token: 'other' });
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated_at ?? null).toBeNull();
  });

  it('success pins validated_at; second call short-circuits without changing validated_at', async () => {
    const db = seed();
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated_at).toBe(NOW);

    vi.setSystemTime(NOW + 10_000);
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated_at).toBe(NOW);
  });

  it('returns Validation failed when UPDATE run() throws after credential match', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE session_id = ?')) {
                  return {
                    session_id: 'sid',
                    email: 'a@b.c',
                    client_secret: 'secret',
                    token: '654321',
                    validated: 0,
                    expires_at: NOW + 60_000,
                  } as T;
                }
                return null;
              },
              async run() {
                throw new Error('update boom');
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({
      success: false,
      error: 'Validation failed',
    });
  });

  it('rejects at expires_at + 1ms and accepts at exact expires_at boundary', async () => {
    const exact = seed({ expires_at: NOW });
    expect(await validateEmailToken(exact, 'sid', 'secret', '654321')).toEqual({ success: true });

    const justPast = seed({ expires_at: NOW - 1 });
    expect(await validateEmailToken(justPast, 'sid', 'secret', '654321')).toEqual({
      success: false,
      error: 'Session expired',
    });
  });
});

describe('getValidatedSession TOKENMAXX HEAVY userId edges after #89', () => {
  it('maps empty-string user_id to userId: undefined via || undefined', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: undefined,
    });
  });

  it('preserves truthy non-null user_id "0"', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '0',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: '0',
    });
  });

  it('does not leak token / client_secret in the returned object', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'leak@ex.com',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: 'top-secret-token',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    const result = await getValidatedSession(db, 'sid', 'secret');
    expect(result).toEqual({ email: 'leak@ex.com', userId: '@u:ex.com' });
    expect(JSON.stringify(result)).not.toContain('top-secret-token');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('returns null for validated=1 row queried with wrong session id', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'other', 'secret')).toBeNull();
  });
});
