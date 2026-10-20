/** Text helpers shared by the parsers. */

const DASHES = /[‐‑‒–—―]/g;

/**
 * Normalise the site's markup into plain text: the pages are full of
 * `&nbsp;` (U+00A0) and `&#8209;` (U+2011, non-breaking hyphen) and the
 * regular hours page uses an en dash between times.
 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/\u00a0/g, ' ')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decode a Cloudflare-obfuscated e-mail address.
 *
 * The markup is `<span class="__cf_email__" data-cfemail="96f2fff8...">`; the
 * first byte of the hex string is the XOR key for the rest.
 */
export function decodeCloudflareEmail(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const clean = hex.trim().toLowerCase();
  if (clean.length < 4 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const bytes = Buffer.from(clean, 'hex');
  const key = bytes[0];
  if (key === undefined) return null;
  let out = '';
  for (let i = 1; i < bytes.length; i += 1) {
    out += String.fromCharCode((bytes[i] as number) ^ key);
  }
  return out;
}
