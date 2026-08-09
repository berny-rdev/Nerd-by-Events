import { useEffect, useState } from 'react';

/**
 * Delays a value until it stops changing for `delayMs`.
 *
 * The cleanup function is the entire point. Every keystroke re-runs the effect,
 * and the cleanup clears the previous timer before the next one is set — so N
 * keystrokes schedule N timers but only the last one survives to fire. Drop the
 * cleanup and you fire a search per character, which is exactly how you burn a
 * daily API quota in an afternoon.
 */
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
