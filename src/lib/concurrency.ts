/**
 * Bounded-concurrency map.
 *
 * Fanning out over an expanded profile means 20+ names against 3 sources — up
 * to ~60 requests for one user action. Firing those at once would stall a phone
 * on a cellular connection and hammer the Worker's rate limiter; a fixed pool
 * keeps the wire busy without flooding it.
 *
 * Returns `PromiseSettledResult`s rather than throwing, matching the shape
 * `Promise.allSettled` produces — one failing query must never reject the whole
 * fan-out.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );

  return results;
}
