import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * Web-only override. The static web build renders on the server, where there's
 * no color scheme to read — so the first client render has to match the server
 * ('light') and only then switch to the real value, or React reports a
 * hydration mismatch.
 *
 * The template shipped this as a `setState` inside an effect, which React's
 * lint rules now flag as a cascading render. `useSyncExternalStore` with a
 * never-changing subscription is the idiomatic version: `getServerSnapshot`
 * returns false, `getSnapshot` returns true, and React handles the swap.
 */
const neverChanges = () => () => {};

export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    neverChanges,
    () => true, // client
    () => false, // server / first hydration pass
  );

  const colorScheme = useRNColorScheme();

  return hasHydrated ? colorScheme : 'light';
}
