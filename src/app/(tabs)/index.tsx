import { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EventCard, EVENT_CARD_HEIGHT } from '@/components/event-card';
import { ExpansionStrip } from '@/components/expansion-strip';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useEvents } from '@/hooks/use-events';
import { useExpansion } from '@/hooks/use-expansion';
import { useSavedEvents, useToggleSave } from '@/hooks/use-saved-events';
import { config } from '@/lib/config';
import { useTheme } from '@/hooks/use-theme';
import type { Event } from '@/sources/types';

export default function BrowseScreen() {
  const theme = useTheme();

  const [keyword, setKeyword] = useState('');
  const [city, setCity] = useState(config.defaultCity);

  /**
   * Only set on an explicit submit, and only ever read by expansion.
   *
   * Expansion runs a large model and takes ~20s cold, so it must never fire per
   * keystroke the way the debounced keyword search does.
   */
  const [submitted, setSubmitted] = useState('');

  // Debounce the *inputs*, not the request. The query key derives from these,
  // so a settled value is what actually triggers a fetch.
  const debouncedKeyword = useDebouncedValue(keyword);
  const debouncedCity = useDebouncedValue(city);

  // Runs alongside the search below. Its *pending* state is read by nothing on
  // the results path — no loading, error, or empty branch consults it, so
  // expansion can take 20 seconds or fail outright and the list is unaffected.
  const expansion = useExpansion(submitted);

  // `names` is empty until expansion lands, so this starts as a plain keyword
  // search and widens into the full fan-out when the names arrive. The widening
  // changes the query key; keepPreviousData inside the hook keeps the first
  // results on screen while the wider search runs.
  const { data, isLoading, isError, error, refetch, isFetching } = useEvents(
    debouncedKeyword,
    debouncedCity,
    expansion.names,
  );

  const { data: saved } = useSavedEvents();
  const { toggle } = useToggleSave();

  const savedIds = useMemo(
    () => new Set((saved ?? []).map((event) => event.id)),
    [saved],
  );

  const events = data?.events ?? [];
  const duplicatesRemoved = (data?.rawCount ?? 0) - events.length;

  const renderItem = ({ item }: { item: Event }) => (
    <EventCard
      event={item}
      accessory={
        <Pressable
          hitSlop={12}
          onPress={() => toggle(item)}
          accessibilityRole="button"
          accessibilityLabel={savedIds.has(item.id) ? 'Remove from saved' : 'Save event'}>
          <ThemedText type="subtitle" style={styles.heart}>
            {savedIds.has(item.id) ? '♥' : '♡'}
          </ThemedText>
        </Pressable>
      }
    />
  );

  return (
    <ThemedView style={styles.screen}>
      {/* edges: SafeAreaView pads for the notch/Dynamic Island at the top; the
          tab bar already handles the home indicator, so 'bottom' is excluded. */}
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <ThemedText type="subtitle">Nearby</ThemedText>

          <View style={styles.inputs}>
            <TextInput
              value={keyword}
              onChangeText={setKeyword}
              placeholder="Artist, team, anything"
              placeholderTextColor={theme.textSecondary}
              autoCorrect={false}
              returnKeyType="search"
              // Submitting is what asks for an expansion. The search itself is
              // already running from the debounce above.
              onSubmitEditing={() => setSubmitted(keyword)}
              style={[
                styles.input,
                { backgroundColor: theme.backgroundElement, color: theme.text },
              ]}
            />
            <TextInput
              value={city}
              onChangeText={setCity}
              placeholder="City"
              placeholderTextColor={theme.textSecondary}
              autoCorrect={false}
              style={[
                styles.input,
                styles.cityInput,
                { backgroundColor: theme.backgroundElement, color: theme.text },
              ]}
            />
          </View>

          <SourceNotices data={data} />
        </View>

        {/* Sits between the inputs and the list, outside every results branch —
            it can never replace or delay what's below it. */}
        <ExpansionStrip {...expansion} isSearching={isFetching} />

        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (
          <FlatList
            data={events}
            renderItem={renderItem}
            // Ids are already namespaced by source, so they're unique across
            // providers. Without a stable key, React remounts every row on
            // refetch and images re-download.
            keyExtractor={(item) => item.id}
            // Cards are a fixed height, so FlatList can compute offsets
            // instead of measuring — this is what keeps fast scrolling smooth.
            getItemLayout={(_, index) => ({
              length: EVENT_CARD_HEIGHT + Spacing.two,
              offset: (EVENT_CARD_HEIGHT + Spacing.two) * index,
              index,
            })}
            contentContainerStyle={styles.list}
            ItemSeparatorComponent={() => <View style={{ height: Spacing.two }} />}
            keyboardDismissMode="on-drag"
            refreshing={isFetching}
            onRefresh={() => refetch()}
            ListEmptyComponent={
              <EmptyState
                title={
                  debouncedKeyword || debouncedCity
                    ? 'No events found'
                    : 'Search for something'
                }
                body={
                  debouncedKeyword || debouncedCity
                    ? 'Try a different keyword, or widen the city.'
                    : 'Type an artist, team, or city to get started.'
                }
              />
            }
            ListFooterComponent={
              duplicatesRemoved > 0 ? (
                <ThemedText type="small" themeColor="textSecondary" style={styles.footer}>
                  {data?.queryCount ?? 0} searches · merged {duplicatesRemoved} duplicate
                  {duplicatesRemoved === 1 ? '' : 's'}
                </ThemedText>
              ) : null
            }
          />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

/**
 * Partial failure made visible.
 *
 * The search still succeeded — this tells the user which providers are missing
 * from the results and why, instead of silently showing a thinner list.
 */
function SourceNotices({ data }: { data: ReturnType<typeof useEvents>['data'] }) {
  if (!data) return null;

  const notices = [
    ...data.skipped.map((s) => `${s.label}: not configured`),
    ...data.failures.map((f) =>
      // A source is only "down" when every one of its queries failed. A few
      // failures out of forty is a different situation and shouldn't read like
      // an outage — so say which it is.
      f.failedQueries >= f.totalQueries
        ? `${f.label}: ${f.message.toLowerCase()}`
        : // Name a query that failed. "3 of 25 failed" alone leaves the cause to
          // be guessed at; the keyword is what makes it diagnosable.
          `${f.label}: ${f.message.toLowerCase()} on ${f.failedQueries} of ${f.totalQueries} queries` +
          (f.sampleQueries[0] ? ` (e.g. "${f.sampleQueries[0]}")` : ''),
    ),
  ];

  if (notices.length === 0) return null;

  return (
    <View style={styles.notices}>
      {notices.map((notice) => (
        <ThemedText key={notice} type="small" themeColor="textSecondary">
          · {notice}
        </ThemedText>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safeArea: { flex: 1 },
  header: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    gap: Spacing.two,
  },
  inputs: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  input: {
    flex: 2,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    // Android centres text in a taller default box; iOS needs explicit padding.
    paddingVertical: Platform.select({ ios: Spacing.two + 2, default: Spacing.one }),
    fontSize: 16,
  },
  cityInput: { flex: 1 },
  notices: { gap: 1 },
  list: {
    padding: Spacing.three,
    paddingBottom: Spacing.six,
    flexGrow: 1, // Lets ListEmptyComponent centre itself in the viewport.
  },
  footer: {
    textAlign: 'center',
    paddingTop: Spacing.three,
  },
  heart: {
    fontSize: 24,
    lineHeight: 30,
  },
});
