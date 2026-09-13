import { describe, it, expect } from 'vitest';
import {
  generateVerificationToken,
  generateSessionId,
} from '../src/services/email';

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
