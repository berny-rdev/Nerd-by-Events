import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EventCard } from '@/components/event-card';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useSavedEvents, useToggleSave } from '@/hooks/use-saved-events';
import { REMINDER_LEAD_MINUTES } from '@/lib/notifications';
import type { SavedEvent } from '@/lib/saved';

export default function SavedScreen() {
  const { data, isLoading, isError, error, refetch } = useSavedEvents();
  const { toggle } = useToggleSave();

  const saved = data ?? [];

  const renderItem = ({ item }: { item: SavedEvent }) => (
    <View>
      <EventCard
        event={item}
        accessory={
          <Pressable
            hitSlop={12}
            onPress={() => toggle(item)}
            accessibilityRole="button"
            accessibilityLabel="Remove from saved">
            <ThemedText type="subtitle" style={styles.heart}>
              ♥
            </ThemedText>
          </Pressable>
        }
      />
      {/* Only shown when a reminder actually got scheduled — undated Google
          listings and denied permissions both leave reminderId unset. */}
      {item.reminderId ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.reminder}>
          🔔 Reminder {REMINDER_LEAD_MINUTES} min before
        </ThemedText>
      ) : null}
    </View>
  );

  if (isLoading) return <LoadingState label="Loading saved events…" />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <ThemedText type="subtitle" style={styles.title}>
          Saved
        </ThemedText>

        <FlatList
          data={saved}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.two }} />}
          ListEmptyComponent={
            <EmptyState
              title="Nothing saved yet"
              body="Tap the heart on any event to keep it here — it survives a force-quit."
            />
          }
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safeArea: { flex: 1 },
  title: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  list: {
    padding: Spacing.three,
    paddingBottom: Spacing.six,
    flexGrow: 1,
  },
  reminder: {
    paddingTop: Spacing.one,
    paddingLeft: Spacing.two,
  },
  heart: {
    fontSize: 24,
    lineHeight: 30,
  },
});
