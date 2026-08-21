/**
 * Separate file because it needs a different `@/lib/config` mock, and a
 * module-level `jest.mock` is the only way to swap it without a dynamic import
 * (unsupported under Jest's CJS mode without --experimental-vm-modules).
 */

import { ClassifyUnavailable, classifyBatch } from '../client';
import type { Event } from '@/sources/types';
import type { ExpansionProfile } from '@/profile/types';

jest.mock('@/lib/config', () => ({
  config: { eventsProxyUrl: '', defaultCity: 'New York' },
  hasProxy: () => false,
}));

const PROFILE: ExpansionProfile = {
  scene: 'Virtual-singer music.',
  core: ['vocaloid'],
  adjacent: [{ name: 'Hatsune Miku', kind: 'artist', why: 'headlines' }],
};

const EVENT: Event = {
  id: 'ticketmaster:1',
  sourceId: '1',
  source: 'ticketmaster',
  title: 'Miku Expo 2026',
  startsAt: null,
  venue: { name: 'Radio City', city: 'New York' },
  url: 'https://example.com',
};

it('fails fast rather than posting to a URL with no base', async () => {
  const fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

  await expect(classifyBatch(PROFILE, [EVENT])).rejects.toBeInstanceOf(ClassifyUnavailable);
  expect(fetchMock).not.toHaveBeenCalled();
});
