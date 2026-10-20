import type { CheerioAPI } from 'cheerio';
import { decodeCloudflareEmail, normalizeText } from './text.js';

export interface LocationDetails {
  address: string | null;
  mapUrl: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Parse the `ul.location-details` block of a location page.
 *
 * The e-mail address is obfuscated by Cloudflare and has to be decoded; a
 * location that publishes no contact details (Wolverine Village) yields nulls.
 */
export function parseLocationDetails($: CheerioAPI): LocationDetails {
  const list = $('ul.location-details').first();
  if (list.length === 0) {
    return { address: null, mapUrl: null, phone: null, email: null };
  }

  const addressElement = list.find('li.address').first();
  const address = normalizeText(addressElement.text()) || null;
  const mapUrl = addressElement.find('a').first().attr('href') ?? null;

  const phoneElement = list.find('li.phone').first();
  const phone = normalizeText(phoneElement.text()) || null;

  const emailElement = list.find('li.email').first();
  const obfuscated = emailElement.find('[data-cfemail]').first().attr('data-cfemail');
  const email = obfuscated ? decodeCloudflareEmail(obfuscated) : normalizeText(emailElement.text()) || null;

  return {
    address: address && address !== '[email protected]' ? address : null,
    mapUrl,
    phone,
    email: email && email.includes('@') ? email : null,
  };
}
