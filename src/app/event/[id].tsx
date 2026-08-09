import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { SourceBadges } from '@/components/source-badge';
import { EmptyState } from '@/components/state-views';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useCachedEvent } from '@/hooks/use-events';
import { useIsSaved, useSavedEvents, useToggleSave } from '@/hooks/use-saved-events';
import { useTheme } from '@/hooks/use-theme';
import { formatEventDate, formatPrice, formatVenue } from '@/lib/format';
import { REMINDER_LEAD_MINUTES } from '@/lib/notifications';

export default function EventDetailScreen() {
  const theme = useTheme();

  // This is the whole route-param story: the list pushed `/event/<id>`, and
  // this reads it back out. Params arrive as strings — always. If you push a
  // number, you get a string here.
  const { id } = useLocalSearchParams<{ id: string }>();

  // Resolve the id against caches rather than refetching. Search results are
  // already in the Query cache; saved events cover the case where the user
  // opened this from the Saved tab with no network.
  const fromSearch = useCachedEvent(id);
  const { data: saved } = useSavedEvents();
  const event = fromSearch ?? saved?.find((item) => item.id === id);

  const isSaved = useIsSaved(id);
  const { toggle, isPending } = useToggleSave();
  const [reminderNote, setReminderNote] = useState<string | null>(null);

  if (!event) {
    return (
      <EmptyState
        title="Event not available"
        body="Search results expire from the cache. Go back and search again."
      />
    );
  }

  const price = formatPrice(event.price);

  const onToggle = async () => {
    const result = await toggle(event);
    if (!result.saved) {
      setReminderNote(null);
      return;
    }

    // Saving succeeded; the reminder is a separate outcome that can fail on
    // its own, and the user deserves to know which happened.
    const reminder = result.reminder;
    if (reminder?.ok) {
      setReminderNote(`Reminder set for ${reminder.firesAt.toLocaleString()}`);
    } else if (reminder) {
      setReminderNote(reminder.message);
      if (reminder.reason === 'denied') {
        Alert.alert('Saved, but no reminder', reminder.message);
      }
    }
  };

  return (
    <ThemedView style={styles.screen}>
      {/* Setting the title here rather than in _layout: the layout doesn't know
          the event name until this screen has resolved it. */}
      <Stack.Screen options={{ title: event.title }} />

      <ScrollView contentContainerStyle={styles.content}>
        {event.imageUrl ? (
          <Image source={event.imageUrl} style={styles.hero} contentFit="cover" transition={200} />
        ) : null}

        <View style={styles.section}>
          <ThemedText type="subtitle">{event.title}</ThemedText>
          <SourceBadges event={event} />
        </View>

        <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
          <Row label="When" value={formatEventDate(event)} />
          <Row label="Where" value={formatVenue(event)} />
          {price ? <Row label="Price" value={price} /> : null}
          {!event.startsAt ? (
            <ThemedText type="small" themeColor="textSecondary">
              This source didn&apos;t give an exact start time, so reminders are unavailable.
            </ThemedText>
          ) : null}
        </View>

        <Pressable
          onPress={onToggle}
          disabled={isPending}
          style={[
            styles.button,
            { backgroundColor: isSaved ? theme.backgroundSelected : '#3c87f7' },
          ]}>
          <ThemedText type="smallBold" style={{ color: isSaved ? theme.text : '#ffffff' }}>
            {isSaved ? 'Saved · tap to remove' : `Save & remind me ${REMINDER_LEAD_MINUTES}m before`}
          </ThemedText>
        </Pressable>

        {reminderNote ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            {reminderNote}
          </ThemedText>
        ) : null}

        <ExternalLink href={event.url}>
          <ThemedText type="linkPrimary">Open tickets →</ThemedText>
        </ExternalLink>
      </ScrollView>
    </ThemedView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.rowLabel}>
        {label}
      </ThemedText>
      <ThemedText type="small" style={styles.rowValue}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  hero: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: Spacing.three,
  },
  section: { gap: Spacing.two },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  row: { flexDirection: 'row', gap: Spacing.three },
  rowLabel: { width: 56 },
  rowValue: { flex: 1 },
  button: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  note: { textAlign: 'center' },
});
