import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { decodeCloudflareEmail } from '../src/parser/text.js';
import { parseLocationDetails } from '../src/parser/location.js';
import { readFixture } from './helpers.js';

describe('cloudflare e-mail decoder', () => {
  it('decodes the Bursley address', () => {
    expect(decodeCloudflareEmail('96f2fff8fff8f1bbf4e3e4e5faf3efd6e3fbfff5feb8f3f2e3')).toBe(
      'dining-bursley@umich.edu',
    );
  });

  it('rejects malformed input', () => {
    expect(decodeCloudflareEmail(null)).toBeNull();
    expect(decodeCloudflareEmail('')).toBeNull();
    expect(decodeCloudflareEmail('xyz')).toBeNull();
    expect(decodeCloudflareEmail('96f2fff8fff8f1bbf4e3e4e5faf3efd6e3fbfff5feb8f3f2e')).toBeNull();
  });
});

describe('location details', () => {
  it('reads the address, phone and e-mail of Bursley', () => {
    const details = parseLocationDetails(load(readFixture('bursley.html')));
    expect(details.address).toBe('1931 Duffield Street, Ann Arbor, MI, 48109');
    expect(details.phone).toBe('734-763-1120');
    expect(details.email).toBe('dining-bursley@umich.edu');
    expect(details.mapUrl).toContain('google.com/maps');
  });

  it('reports no contact details for Wolverine Village', () => {
    const details = parseLocationDetails(load(readFixture('wolverine-village-dining-hall.html')));
    expect(details.address).toBeNull();
    expect(details.phone).toBeNull();
    expect(details.email).toBeNull();
  });
});
