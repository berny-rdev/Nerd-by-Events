import * as Location from 'expo-location';

import { classifyPermission, pickCityName, resolveCurrentCity } from '../location';

jest.mock('expo-location', () => ({
  PermissionStatus: { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' },
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
}));

const mocked = Location as jest.Mocked<typeof Location>;

/** Every field on LocationGeocodedAddress is nullable — build them that way. */
function address(overrides: Partial<Location.LocationGeocodedAddress> = {}) {
  return {
    city: null,
    district: null,
    streetNumber: null,
    street: null,
    region: null,
    subregion: null,
    country: null,
    postalCode: null,
    name: null,
    isoCountryCode: null,
    timezone: null,
    formattedAddress: null,
    ...overrides,
  } as Location.LocationGeocodedAddress;
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.hasServicesEnabledAsync.mockResolvedValue(true);
  mocked.getCurrentPositionAsync.mockResolvedValue({
    coords: { latitude: 40.7, longitude: -74 },
  } as Location.LocationObject);
});

describe('classifyPermission', () => {
  it('reports granted', () => {
    expect(classifyPermission({ granted: true, canAskAgain: false, status: 'granted' })).toBe(
      'granted',
    );
  });

  it('reports undetermined before any prompt has been shown', () => {
    // canAskAgain is irrelevant here — nothing has been asked yet.
    expect(
      classifyPermission({ granted: false, canAskAgain: false, status: 'undetermined' }),
    ).toBe('undetermined');
  });

  it('separates a re-askable denial from a permanent one', () => {
    expect(classifyPermission({ granted: false, canAskAgain: true, status: 'denied' })).toBe(
      'denied',
    );
    // Collapsing these two would either nag someone who said no, or send
    // someone to Settings who never saw a prompt.
    expect(classifyPermission({ granted: false, canAskAgain: false, status: 'denied' })).toBe(
      'blocked',
    );
  });
});

describe('pickCityName', () => {
  it('prefers city', () => {
    expect(pickCityName([address({ city: 'New York', subregion: 'Kings County' })])).toBe(
      'New York',
    );
  });

  it('falls back through district, subregion, then region', () => {
    // A geocode can succeed with city: null — rural areas and some Android
    // devices do exactly this.
    expect(pickCityName([address({ district: 'Brooklyn' })])).toBe('Brooklyn');
    expect(pickCityName([address({ subregion: 'Kings County' })])).toBe('Kings County');
    expect(pickCityName([address({ region: 'New York' })])).toBe('New York');
  });

  it('never falls back to country', () => {
    // "United States" as a city filter silently turns a local search national.
    expect(pickCityName([address({ country: 'United States' })])).toBeNull();
  });

  it('skips an address with nothing usable and tries the next', () => {
    expect(pickCityName([address(), address({ city: 'Austin' })])).toBe('Austin');
  });

  it('ignores whitespace-only values', () => {
    expect(pickCityName([address({ city: '   ', district: 'Shibuya' })])).toBe('Shibuya');
  });

  it('returns null for an empty result', () => {
    expect(pickCityName([])).toBeNull();
  });
});

describe('resolveCurrentCity permission flow', () => {
  const permission = (granted: boolean, canAskAgain: boolean, status: string) =>
    ({ granted, canAskAgain, status }) as Location.LocationPermissionResponse;

  it('prompts only when permission has never been asked', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(
      permission(false, true, 'undetermined'),
    );
    mocked.requestForegroundPermissionsAsync.mockResolvedValue(permission(true, false, 'granted'));
    mocked.reverseGeocodeAsync.mockResolvedValue([address({ city: 'New York' })]);

    await expect(resolveCurrentCity()).resolves.toEqual({ kind: 'ok', city: 'New York' });
    expect(mocked.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not re-prompt when already granted', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(true, false, 'granted'));
    mocked.reverseGeocodeAsync.mockResolvedValue([address({ city: 'Austin' })]);

    await expect(resolveCurrentCity()).resolves.toEqual({ kind: 'ok', city: 'Austin' });
    expect(mocked.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not re-prompt after a denial', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(false, true, 'denied'));

    await expect(resolveCurrentCity()).resolves.toEqual({ kind: 'denied' });
    // iOS silently refuses to show the dialog again, so a second request would
    // resolve unchanged and look like the button did nothing.
    expect(mocked.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mocked.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('reports a permanent denial distinctly', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(false, false, 'denied'));

    await expect(resolveCurrentCity()).resolves.toEqual({ kind: 'blocked' });
  });

  it('reports a denial made at the prompt itself', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(
      permission(false, true, 'undetermined'),
    );
    mocked.requestForegroundPermissionsAsync.mockResolvedValue(permission(false, false, 'denied'));

    await expect(resolveCurrentCity()).resolves.toEqual({ kind: 'blocked' });
  });
});

describe('resolveCurrentCity failure paths', () => {
  beforeEach(() => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: false,
      status: 'granted',
    } as Location.LocationPermissionResponse);
  });

  it('handles permission granted but location services switched off', async () => {
    mocked.hasServicesEnabledAsync.mockResolvedValue(false);

    const outcome = await resolveCurrentCity();

    expect(outcome.kind).toBe('unavailable');
    expect(mocked.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('handles a geocode that resolves to no city at all', async () => {
    mocked.reverseGeocodeAsync.mockResolvedValue([address({ country: 'United States' })]);

    const outcome = await resolveCurrentCity();

    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: "Couldn't work out a city from your location.",
    });
  });

  it('handles an empty geocode result', async () => {
    mocked.reverseGeocodeAsync.mockResolvedValue([]);

    expect((await resolveCurrentCity()).kind).toBe('unavailable');
  });

  it('never throws when the platform does', async () => {
    mocked.getCurrentPositionAsync.mockRejectedValue(new Error('Location request timed out'));

    const outcome = await resolveCurrentCity();

    // The caller renders the outcome; it must never have to catch.
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'Location request timed out' });
  });
});
