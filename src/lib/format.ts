import type { Event, Money } from '@/sources/types';

/**
 * Renders whatever date information we actually have.
 *
 * Sources that gave us a real instant get a formatted local date; Google's
 * fuzzy strings get passed through as-is. Never fabricate precision the source
 * didn't provide.
 */
export function formatEventDate(event: Pick<Event, 'startsAt' | 'startsAtLabel'>): string {
  if (!event.startsAt) return event.startsAtLabel ?? 'Date TBA';

  const date = new Date(event.startsAt);
  if (Number.isNaN(date.getTime())) return event.startsAtLabel ?? 'Date TBA';

  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatPrice(price?: Money): string | undefined {
  if (!price) return undefined;

  const format = (value: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency,
      maximumFractionDigits: 0,
    }).format(value);

  return price.min === price.max ? format(price.min) : `${format(price.min)} – ${format(price.max)}`;
}

export function formatVenue(event: Pick<Event, 'venue'>): string {
  const { name, city } = event.venue;
  return city && name !== city ? `${name} · ${city}` : name;
}
