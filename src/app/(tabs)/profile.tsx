import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ErrorState, LoadingState } from '@/components/state-views';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTasteProfile } from '@/hooks/use-taste-profile';
import { useTheme } from '@/hooks/use-theme';
import { hasExpansion } from '@/profile/types';

export default function ProfileScreen() {
  const theme = useTheme();
  const { profile, isLoading, isError, error, refetch, addTag, removeTag, isSaving } =
    useTasteProfile();

  const [draft, setDraft] = useState('');

  const submit = async () => {
    // Normalization lives in `@/profile/tags` — a blank or duplicate submit is
    // a no-op there, so the screen doesn't need its own guard. Clearing the
    // input regardless is deliberate: re-typing a duplicate and having the box
    // stay full reads as "it didn't work".
    await addTag(draft);
    setDraft('');
  };

  if (isLoading) return <LoadingState label="Loading your profile…" />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="on-drag">
          <View style={styles.section}>
            <ThemedText type="subtitle">Your taste</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Add the acts, teams and scenes you follow. These will be used to rank events.
            </ThemedText>
          </View>

          <View style={styles.section}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              placeholder="Add an artist, team or genre"
              placeholderTextColor={theme.textSecondary}
              autoCorrect={false}
              autoCapitalize="words"
              // Keeps the keyboard up for the next tag instead of dismissing
              // after every single one. (`submitBehavior` supersedes the
              // deprecated `blurOnSubmit`.)
              submitBehavior="submit"
              returnKeyType="done"
              editable={!isSaving}
              style={[
                styles.input,
                { backgroundColor: theme.backgroundElement, color: theme.text },
              ]}
            />

            {profile.tags.length === 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                No tags yet.
              </ThemedText>
            ) : (
              <View style={styles.chips}>
                {profile.tags.map((tag) => (
                  <Pressable
                    key={tag.toLowerCase()}
                    onPress={() => removeTag(tag)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${tag}`}
                    style={({ pressed }) => [
                      styles.chip,
                      {
                        backgroundColor: pressed
                          ? theme.backgroundSelected
                          : theme.backgroundElement,
                      },
                    ]}>
                    <ThemedText type="small">{tag}</ThemedText>
                    <Ionicons name="close" size={14} color={theme.textSecondary} />
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          <ExpansionSection profile={profile} />
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

/**
 * Read-only view of whatever the expansion step produced.
 *
 * Nothing writes `scene` or `adjacent` yet, so in practice this always renders
 * its empty state today. It's built now so the storage shape and the UI agree
 * before the generating code exists.
 */
function ExpansionSection({ profile }: { profile: ReturnType<typeof useTasteProfile>['profile'] }) {
  const theme = useTheme();

  if (!hasExpansion(profile)) {
    return (
      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold">Scene &amp; similar acts</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Generated from your tags by a later step. Nothing here yet — add some tags and check
          back once expansion is wired up.
        </ThemedText>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {profile.scene ? (
        <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">Scene</ThemedText>
          <ThemedText type="small">{profile.scene}</ThemedText>
        </View>
      ) : null}

      {profile.adjacent.length > 0 ? (
        <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">You might also follow</ThemedText>
          {profile.adjacent.map((item) => (
            <View key={item.name} style={styles.adjacentRow}>
              <ThemedText type="small">{item.name}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {item.why}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safeArea: { flex: 1 },
  content: {
    padding: Spacing.three,
    paddingBottom: Spacing.six,
    gap: Spacing.four,
  },
  section: { gap: Spacing.two },
  input: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Platform.select({ ios: Spacing.two + 2, default: Spacing.one }),
    fontSize: 16,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.four,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  adjacentRow: { gap: 1 },
});
