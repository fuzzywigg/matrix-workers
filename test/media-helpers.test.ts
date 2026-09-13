import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename,
  safeContentDisposition,
  decodeHtmlEntities,
  SUPPORTED_TYPES,
} from '../src/api/media';

describe('sanitizeFilename', () => {
  it('strips path traversal and header-injection characters', () => {
    expect(sanitizeFilename('../etc/passwd')).toBe('.._etc_passwd');
    expect(sanitizeFilename('a\r\nX-Injected: 1.jpg')).toBe('a__X-Injected__1.jpg');
    expect(sanitizeFilename('photo"quote.png')).toBe('photo_quote.png');
  });

  it('preserves safe characters and truncates length', () => {
    expect(sanitizeFilename('My-Photo_01.JPEG')).toBe('My-Photo_01.JPEG');
    expect(sanitizeFilename('x'.repeat(300)).length).toBe(255);
  });
});

describe('safeContentDisposition', () => {
  it('wraps the sanitized name in an inline disposition', () => {
    expect(safeContentDisposition('hi world.png')).toBe('inline; filename="hi_world.png"');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes common entities once', () => {
    expect(decodeHtmlEntities('&lt;b&gt;&quot;hi&quot;&amp;')).toBe('<b>"hi"&');
    expect(decodeHtmlEntities('&#039;&#x27;&#x2F;&nbsp;')).toBe("''/ ");
  });

  it('does not double-decode &amp;lt;', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('SUPPORTED_TYPES', () => {
  it('includes common media and fallback octet-stream', () => {
    expect(SUPPORTED_TYPES).toContain('image/png');
    expect(SUPPORTED_TYPES).toContain('application/octet-stream');
  });
});
