/**
 * Device location -> a city string.
 *
 * Every source takes a city name, so this resolves coordinates all the way to
 * one rather than widening that contract. Raw lat/lon would mean changing three
 * adapters, the Worker routes, and the cache keys — far more than a "near me"
 * button warrants.
 *
 * Nothing here runs at launch. `resolveCurrentCity` is called from a tap and
 * only from a tap: a cold permission prompt before anyone has seen what the app
 * does is the fastest way to get denied permanently.
 */

import * as Location from 'expo-location';

/**
 * The four states worth distinguishing.
 *
 * `denied` and `blocked` differ in what the user can do next: `denied` can be
 * re-prompted, `blocked` can only be fixed in Settings. Collapsing them means
 * either nagging someone who already said no, or sending someone to Settings
 * who never actually saw a prompt.
 */
export type PermissionState = 'undetermined' | 'granted' | 'denied' | 'blocked';

export type PermissionLike = {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
};

export function classifyPermission(permission: PermissionLike): PermissionState {
  if (permission.granted) return 'granted';
  // `undetermined` means no prompt has been shown yet, so it is askable
  // regardless of what canAskAgain claims.
  if (permission.status === Location.PermissionStatus.UNDETERMINED) return 'undetermined';
  return permission.canAskAgain ? 'denied' : 'blocked';
}

/**
 * Picks a usable city name from a reverse-geocode result.
 *
 * Every field on `LocationGeocodedAddress` is `string | null`, `city` included —
 * a geocode can succeed and still not name a city, which happens in rural areas
 * and on some Android devices. The fallbacks are ordered by how well each maps
 * onto what a ticketing API means by "city":
 *
 *   city      what we want
 *   district  a borough or city subdivision; still a place people search
 *   subregion typically the county — coarse, but better than nothing
 *   region    state/province; a last resort that will over-broaden the search
 *
 * `country` is deliberately not a fallback: "United States" as a city filter
 * would silently turn a local search into a national one.
 */
export function pickCityName(addresses: Location.LocationGeocodedAddress[]): string | null {
  for (const address of addresses) {
    // Each candidate is tested independently rather than chained with `??`,
    // which only skips null — a present-but-blank `city` would otherwise mask a
    // perfectly good `district` and resolve to nothing.
    for (const candidate of [address.city, address.district, address.subregion, address.region]) {
      const cleaned = candidate?.trim();
      if (cleaned) return cleaned;
    }
  }
  return null;
}

export type LocationOutcome =
  | { kind: 'ok'; city: string }
  /** Prompt shown and refused; asking again is allowed. */
  | { kind: 'denied' }
  /** Refused for good — only Settings can change it. */
  | { kind: 'blocked' }
  /** Permission was fine; something else stopped us. */
  | { kind: 'unavailable'; reason: string };

/**
 * Resolves the device's city, prompting for permission only if it has never
 * been asked.
 *
 * Re-prompting when already denied is pointless — on iOS the OS silently
 * refuses to show the dialog a second time, so the call would resolve
 * unchanged and look like the button did nothing.
 */
export async function resolveCurrentCity(): Promise<LocationOutcome> {
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    let state = classifyPermission(permission);

    if (state === 'undetermined') {
      permission = await Location.requestForegroundPermissionsAsync();
      state = classifyPermission(permission);
    }

    if (state === 'denied') return { kind: 'denied' };
    if (state === 'blocked') return { kind: 'blocked' };

    // Permission can be granted while location services are switched off
    // device-wide, in which case getCurrentPositionAsync hangs or throws.
    if (!(await Location.hasServicesEnabledAsync())) {
      return { kind: 'unavailable', reason: 'Location services are turned off.' };
    }

    const position = await Location.getCurrentPositionAsync({
      // Balanced is roughly city-block accuracy — far more than enough to name
      // a city, and much faster and cheaper on battery than High.
      accuracy: Location.Accuracy.Balanced,
    });

    const addresses = await Location.reverseGeocodeAsync({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });

    const city = pickCityName(addresses);
    if (!city) {
      return { kind: 'unavailable', reason: "Couldn't work out a city from your location." };
    }

    return { kind: 'ok', city };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : "Couldn't read your location.",
    };
  }
}
