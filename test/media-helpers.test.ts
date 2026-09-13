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

  it('prefers og:title over <title> when both exist', () => {
    const html = `
      <title>Page Title</title>
      <meta property="og:title" content="OG Title" />
    `;
    expect(extractOpenGraphPreview(html)['og:title']).toBe('OG Title');
  });

  it('leaves absolute og:image URLs unchanged when baseUrl is set', () => {
    const base = { protocol: 'https:', host: 'example.com' };
    expect(
      extractOpenGraphPreview(
        `<meta property="og:image" content="https://cdn.example.com/x.png" />`,
        base
      )['og:image']
    ).toBe('https://cdn.example.com/x.png');
  });

  it('decodes entities in meta description fallback', () => {
    const html = `<meta name="description" content="A &amp; B" />`;
    expect(extractOpenGraphPreview(html)['og:description']).toBe('A & B');
  });
});

describe('MIME helpers edge cases', () => {
  it('rejects empty and unknown MIME after parameter strip', () => {
    expect(isSupportedContentType('')).toBe(false);
    expect(isSupportedContentType('application/x-msdownload')).toBe(false);
    expect(isSupportedContentType('text/html')).toBe(false);
  });

  it('accepts svg and webp from the whitelist', () => {
    expect(isSupportedContentType('image/svg+xml')).toBe(true);
    expect(isSupportedContentType('image/webp')).toBe(true);
  });

  it('clamps parseInt float prefixes', () => {
    expect(clampThumbnailDimension('96.9')).toBe(96);
    expect(clampThumbnailDimension('1')).toBe(1);
    expect(clampThumbnailDimension('1920')).toBe(1920);
  });
});

describe('sanitizeFilename / disposition failure edges', () => {
  it('neutralizes path separators and null bytes', () => {
    expect(sanitizeFilename('a\\b/c')).toBe('a_b_c');
    expect(sanitizeFilename('evil\0name.png')).toBe('evil_name.png');
    expect(sanitizeFilename('..')).toBe('..');
  });

  it('builds disposition from injection-prone names', () => {
    expect(safeContentDisposition('../x\r\nSet-Cookie: a=b.png')).toBe(
      'inline; filename=".._x__Set-Cookie__a_b.png"'
    );
  });
});

describe('decodeHtmlEntities failure edges', () => {
  it('leaves unknown entities and bare ampersands alone', () => {
    expect(decodeHtmlEntities('&unknown;')).toBe('&unknown;');
    expect(decodeHtmlEntities('a & b')).toBe('a & b');
  });

  it('decodes greater-than and nested amp-gt once', () => {
    expect(decodeHtmlEntities('&gt;')).toBe('>');
    expect(decodeHtmlEntities('&amp;gt;')).toBe('&gt;');
  });
});

describe('extractOpenGraphPreview failure / alternate attribute order', () => {
  it('reads single-quoted meta attributes', () => {
    const html = `<meta property='og:title' content='Quoted' />`;
    expect(extractOpenGraphPreview(html)['og:title']).toBe('Quoted');
  });

  it('extracts content-before-property for description, image, site_name, and type', () => {
    const html = `
      <meta content="D" property="og:description" />
      <meta content="/rel.png" property="og:image" />
      <meta content="SiteX" property="og:site_name" />
      <meta content="article" property="og:type" />
    `;
    const base = { protocol: 'https:', host: 'ex.test' };
    expect(extractOpenGraphPreview(html, base)).toEqual({
      'og:description': 'D',
      'og:image': 'https://ex.test/rel.png',
      'og:site_name': 'SiteX',
      'og:type': 'article',
    });
  });

  it('does not absolutize when baseUrl is omitted', () => {
    expect(
      extractOpenGraphPreview(`<meta property="og:image" content="/rel.png" />`)['og:image']
    ).toBe('/rel.png');
  });

  it('leaves http(s) images unchanged even when relative absolutization is enabled', () => {
    const base = { protocol: 'https:', host: 'ex.test' };
    expect(
      extractOpenGraphPreview(
        `<meta property="og:image" content="http://cdn.test/a.png" />`,
        base
      )['og:image']
    ).toBe('http://cdn.test/a.png');
  });
});

describe('MIME / thumbnail / security header edges', () => {
  it('accepts audio and video whitelist entries with parameters', () => {
    expect(isSupportedContentType('audio/ogg; codecs=vorbis')).toBe(true);
    expect(isSupportedContentType('video/webm; codecs=vp9')).toBe(true);
    expect(isSupportedContentType('application/json; charset=utf-8')).toBe(true);
  });

  it('rejects leading-semicolon MIME that parses to empty base type', () => {
    expect(parseBaseContentType(';charset=utf-8')).toBe('');
    expect(isSupportedContentType(';charset=utf-8')).toBe(false);
  });

  it('clamps hex-looking and whitespace dimension strings via parseInt', () => {
    expect(clampThumbnailDimension('0x10')).toBe(96); // parseInt → 0 → fallback
    expect(clampThumbnailDimension(' 128 ')).toBe(128);
  });

  it('overwrites existing security headers', () => {
    const headers = new Headers({
      'X-Content-Type-Options': 'old',
      'Content-Security-Policy': 'old',
      'X-Frame-Options': 'ALLOWALL',
    });
    addMediaSecurityHeaders(headers);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('treats MIME whitelist membership as case-sensitive', () => {
    expect(isSupportedContentType('IMAGE/PNG')).toBe(false);
    expect(isSupportedContentType('Text/Plain')).toBe(false);
    expect(isSupportedContentType('image/png')).toBe(true);
  });
});

describe('extractOpenGraphPreview absolutization / decode edges', () => {
  it('treats protocol-relative og:image as a root-path URL', () => {
    const base = { protocol: 'https:', host: 'ex.com' };
    // startsWith('/') is true for "//cdn…", so host is prepended without a slash join
    expect(
      extractOpenGraphPreview(`<meta property="og:image" content="//cdn.ex/a.png" />`, base)[
        'og:image'
      ]
    ).toBe('https://ex.com//cdn.ex/a.png');
  });

  it('treats uppercase HTTPS schemes as relative paths (case-sensitive http check)', () => {
    const base = { protocol: 'https:', host: 'ex.com' };
    expect(
      extractOpenGraphPreview(`<meta property="og:image" content="HTTPS://cdn.ex/a.png" />`, base)[
        'og:image'
      ]
    ).toBe('https://ex.com/HTTPS://cdn.ex/a.png');
  });

  it('decodes entities in og:title but leaves og:type raw', () => {
    const html = `
      <meta property="og:title" content="web&amp;site" />
      <meta property="og:type" content="web&amp;site" />
    `;
    const preview = extractOpenGraphPreview(html);
    expect(preview['og:title']).toBe('web&site');
    expect(preview['og:type']).toBe('web&amp;site');
  });
});


describe('media helpers TOKENMAXX edge paths after #49', () => {
  it('reads meta description with content-before-name attribute order', () => {
    const html = `<meta content="D &amp; E" name="description" />`;
    expect(extractOpenGraphPreview(html)['og:description']).toBe('D & E');
  });

  it('decodes entities in og:site_name', () => {
    const html = `<meta property="og:site_name" content="Acme &amp; Co" />`;
    expect(extractOpenGraphPreview(html)['og:site_name']).toBe('Acme & Co');
  });

  it('uses a custom fallback when clamp sees falsy parseInt zero', () => {
    expect(clampThumbnailDimension('0', 32)).toBe(32);
    expect(clampThumbnailDimension('', 64)).toBe(64);
  });

  it('accepts remaining audio/video whitelist MIME entries', () => {
    expect(isSupportedContentType('audio/mp3')).toBe(true);
    expect(isSupportedContentType('audio/mpeg')).toBe(true);
    expect(isSupportedContentType('video/mp4')).toBe(true);
    expect(isSupportedContentType('audio/wav')).toBe(true);
    expect(parseBaseContentType('')).toBe('');
  });

  it('leaves filenames at the 255-char truncate boundary unchanged in length', () => {
    const exact = 'x'.repeat(255);
    expect(sanitizeFilename(exact)).toBe(exact);
    expect(sanitizeFilename(exact).length).toBe(255);
  });

  it('builds disposition for empty filenames', () => {
    expect(safeContentDisposition('')).toBe('inline; filename=""');
  });

  it('prefers og:description over meta description when both exist', () => {
    const html = `
      <meta property="og:description" content="OG" />
      <meta name="description" content="Meta" />
    `;
    expect(extractOpenGraphPreview(html)['og:description']).toBe('OG');
  });
});
