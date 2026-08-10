import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { useExpansion } from '@/hooks/use-expansion';

type Props = ReturnType<typeof useExpansion>;

/**
 * The expansion state, rendered above the results.
 *
 * This strip is purely additive — the results list below it is already
 * populated from the keyword search before this shows anything but a spinner,
 * and every terminal state here still leaves those results on screen. There is
 * no branch that produces a dead end.
 */
export function ExpansionStrip({ profile, names, isPending, isEmpty, isError, isActive }: Props) {
  const theme = useTheme();

  // Nothing submitted yet.
  if (!isActive) return null;

  if (isPending) {
    return (
      <View style={[styles.container, { backgroundColor: theme.backgroundElement }]}>
        <View style={styles.row}>
          <ActivityIndicator size="small" color={theme.textSecondary} />
          <ThemedText type="small" themeColor="textSecondary">
            Finding related acts… results below are ready now.
          </ThemedText>
        </View>
      </View>
    );
  }

  // Both failure shapes land here. The wording avoids implying anything is
  // broken, because from the user's side nothing is — they have results.
  if (isError || isEmpty || !profile) {
    return (
      <View style={[styles.container, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="small" themeColor="textSecondary">
          Couldn&apos;t work out related acts for this search — showing keyword results.
        </ThemedText>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
        {profile.scene}
      </ThemedText>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}>
        {names.map((name) => (
          <View
            key={name.toLowerCase()}
            style={[styles.chip, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="small">{name}</ThemedText>
          </View>
        ))}
      </ScrollView>

      <ThemedText type="small" themeColor="textSecondary" style={styles.footnote}>
        {names.length} related name{names.length === 1 ? '' : 's'} — not searched yet
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Spacing.three,
    marginTop: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  chips: {
    gap: Spacing.two,
    paddingVertical: Spacing.half,
  },
  chip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  footnote: {
    fontSize: 11,
    lineHeight: 14,
  },
});
