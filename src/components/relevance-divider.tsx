import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export const DIVIDER_HEIGHT = 44;

/**
 * Marks where relevance falls off.
 *
 * Sits below POSSIBLE, so the tier worth scanning for surprises stays above the
 * line. Everything beneath it is still in the same scrollable list — this is a
 * signpost, not a cut, and the count says so out loud.
 */
export function RelevanceDivider({ below }: { below: number }) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <View style={[styles.rule, { backgroundColor: theme.backgroundSelected }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
        {below} weaker match{below === 1 ? '' : 'es'} below
      </ThemedText>
      <View style={[styles.rule, { backgroundColor: theme.backgroundSelected }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: DIVIDER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rule: { flex: 1, height: 1 },
  label: { fontSize: 11, lineHeight: 15 },
});
