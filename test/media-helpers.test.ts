import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename,
  safeContentDisposition,
  decodeHtmlEntities,
  SUPPORTED_TYPES,
  parseBaseContentType,
  isSupportedContentType,
  clampThumbnailDimension,
  addMediaSecurityHeaders,
  extractOpenGraphPreview,
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

  it('handles empty and unicode names', () => {
    expect(sanitizeFilename('')).toBe('');
    expect(sanitizeFilename('写真.png')).toBe('__.png');
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

describe('SUPPORTED_TYPES / MIME helpers', () => {
  it('includes common media and fallback octet-stream', () => {
    expect(SUPPORTED_TYPES).toContain('image/png');
    expect(SUPPORTED_TYPES).toContain('application/octet-stream');
  });

  it('strips MIME parameters via parseBaseContentType', () => {
    expect(parseBaseContentType('image/png; charset=utf-8')).toBe('image/png');
    expect(parseBaseContentType('  text/plain ;charset=utf-8')).toBe('text/plain');
    expect(parseBaseContentType('application/octet-stream')).toBe('application/octet-stream');
  });

  it('accepts whitelisted types and rejects others', () => {
    expect(isSupportedContentType('image/jpeg; charset=binary')).toBe(true);
    expect(isSupportedContentType('application/pdf')).toBe(true);
    expect(isSupportedContentType('text/html')).toBe(false);
    expect(isSupportedContentType('application/x-msdownload')).toBe(false);
  });
});

describe('clampThumbnailDimension', () => {
  it('defaults missing/invalid values to the fallback', () => {
    expect(clampThumbnailDimension(undefined)).toBe(96);
    expect(clampThumbnailDimension('')).toBe(96);
    expect(clampThumbnailDimension('nope')).toBe(96);
    expect(clampThumbnailDimension(undefined, 32)).toBe(32);
  });

  it('clamps to [1, 1920]', () => {
    // parseInt('0') || fallback → falsy 0 uses fallback (existing behavior)
    expect(clampThumbnailDimension('0')).toBe(96);
    expect(clampThumbnailDimension('-5')).toBe(1); // Math.max(1, -5) after || doesn't apply (parseInt works)
    expect(clampThumbnailDimension('5000')).toBe(1920);
    expect(clampThumbnailDimension('128')).toBe(128);
  });
});

describe('addMediaSecurityHeaders', () => {
  it('sets nosniff, CSP, and frame denial', () => {
    const headers = new Headers();
    addMediaSecurityHeaders(headers);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('extractOpenGraphPreview', () => {
  it('extracts og tags with property-before-content order', () => {
    const html = `
      <meta property="og:title" content="Hello &amp; World" />
      <meta property="og:description" content="Desc" />
      <meta property="og:image" content="https://cdn.example.com/a.png" />
      <meta property="og:site_name" content="Site" />
      <meta property="og:type" content="website" />
    `;
    expect(extractOpenGraphPreview(html)).toEqual({
      'og:title': 'Hello & World',
      'og:description': 'Desc',
      'og:image': 'https://cdn.example.com/a.png',
      'og:site_name': 'Site',
      'og:type': 'website',
    });
  });

  it('extracts og tags with content-before-property order', () => {
    const html = `<meta content="Alt Title" property="og:title" />`;
    expect(extractOpenGraphPreview(html)['og:title']).toBe('Alt Title');
  });

  it('falls back to title and meta description', () => {
    const html = `
      <title>Page &lt;Title&gt;</title>
      <meta name="description" content="Meta desc" />
    `;
    expect(extractOpenGraphPreview(html)).toEqual({
      'og:title': 'Page <Title>',
      'og:description': 'Meta desc',
    });
  });

  it('absolutizes relative og:image URLs when baseUrl is provided', () => {
    const base = { protocol: 'https:', host: 'example.com' };
    expect(
      extractOpenGraphPreview(`<meta property="og:image" content="/img/a.png" />`, base)['og:image']
    ).toBe('https://example.com/img/a.png');
    expect(
      extractOpenGraphPreview(`<meta property="og:image" content="img/b.png" />`, base)['og:image']
    ).toBe('https://example.com/img/b.png');
  });

  it('returns empty object when no preview fields exist', () => {
    expect(extractOpenGraphPreview('<html><body>hi</body></html>')).toEqual({});
  });
});
