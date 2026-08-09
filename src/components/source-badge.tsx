import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Event, SourceId } from '@/sources/types';

const LABELS: Record<SourceId, string> = {
  ticketmaster: 'Ticketmaster',
  seatgeek: 'SeatGeek',
  serpapi: 'Google',
};

/**
 * Shows which provider(s) an event came from. Mostly a debugging affordance
 * while tuning the deduper — when the same show is showing up twice, this is
 * how you see it immediately.
 */
export function SourceBadges({ event }: { event: Event }) {
  const theme = useTheme();
  const sources = event.mergedFrom ?? [event.source];

  return (
    <View style={styles.row}>
      {sources.map((source) => (
        <View key={source} style={[styles.badge, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.text}>
            {LABELS[source]}
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.one,
    flexWrap: 'wrap',
  },
  badge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Spacing.two,
  },
  text: {
    fontSize: 11,
    lineHeight: 16,
  },
});
