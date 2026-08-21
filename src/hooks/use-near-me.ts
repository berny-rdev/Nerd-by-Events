import { useCallback, useState } from 'react';
import { Linking } from 'react-native';

import { resolveCurrentCity } from '@/lib/location';

export type NearMeStatus =
  | { kind: 'idle' }
  | { kind: 'locating' }
  /** Something to tell the user. `canOpenSettings` drives the Settings action. */
  | { kind: 'note'; message: string; canOpenSettings: boolean };

/**
 * The "near me" affordance.
 *
 * Only ever runs from a tap — there is no effect here, deliberately. The
 * permission prompt should arrive when someone has asked for their location,
 * not when the app opens.
 *
 * Every terminal state leaves the city field untouched and editable. Location
 * is a shortcut for typing, so failing at it must cost nothing more than the
 * typing it would have saved.
 */
export function useNearMe(onCity: (city: string) => void) {
  const [status, setStatus] = useState<NearMeStatus>({ kind: 'idle' });

  const locate = useCallback(async () => {
    setStatus({ kind: 'locating' });
    const outcome = await resolveCurrentCity();

    switch (outcome.kind) {
      case 'ok':
        onCity(outcome.city);
        setStatus({ kind: 'idle' });
        return;

      case 'denied':
        // Re-askable, so no Settings detour — tapping again re-prompts.
        setStatus({
          kind: 'note',
          message: 'Location access denied. You can still type a city.',
          canOpenSettings: false,
        });
        return;

      case 'blocked':
        setStatus({
          kind: 'note',
          message: 'Location is off for this app. Type a city, or turn it on in Settings.',
          canOpenSettings: true,
        });
        return;

      case 'unavailable':
        setStatus({ kind: 'note', message: `${outcome.reason} Type a city instead.`, canOpenSettings: false });
    }
  }, [onCity]);

  const dismiss = useCallback(() => setStatus({ kind: 'idle' }), []);

  const openSettings = useCallback(() => {
    // The only route back from a permanent denial; the OS dialog will not
    // appear again on its own.
    void Linking.openSettings();
  }, []);

  return { status, locate, dismiss, openSettings };
}
