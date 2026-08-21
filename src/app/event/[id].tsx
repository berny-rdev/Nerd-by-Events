import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { SourceBadges } from '@/components/source-badge';
import { EmptyState, LoadingState } from '@/components/state-views';
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

  /**
   * Resolve the id against caches rather than refetching.
   *
   * Deliberately no refetch-by-id, including on a cold start from a reminder
   * tap. Three reasons:
   *
   *  - A reminder only exists for a *saved* event — `useToggleSave` schedules
   *    on save and cancels on unsave — and saved events persist the whole
   *    record, not just an id. So the store is guaranteed to have it.
   *  - SerpAPI has no fetch-by-id endpoint at all, so a refetch path would work
   *    for two sources out of three and quietly fail for the third.
   *  - A reminder fires an hour before a show, which is exactly when someone is
   *    most likely to be out and on a bad connection. Reading local storage
   *    works there; a network round trip may not.
   */
  const fromSearch = useCachedEvent(id);
  const { data: saved, isPending: savedPending } = useSavedEvents();
  const event = fromSearch ?? saved?.find((item) => item.id === id);

  const isSaved = useIsSaved(id);
  const { toggle, isPending } = useToggleSave();
  const [reminderNote, setReminderNote] = useState<string | null>(null);

  // The saved store is read asynchronously, so on a cold start it is still
  // pending for the first frames. Without this the user taps a reminder and is
  // greeted by "Event not available" before the read resolves — the empty state
  // must mean "absent", not "not yet loaded".
  if (!event && savedPending) {
    return <LoadingState label="Opening event…" />;
  }

  if (!event) {
    return (
      <EmptyState
        title="Event not available"
        body="This event is no longer saved and isn't in recent search results. Search for it again to see it."
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
