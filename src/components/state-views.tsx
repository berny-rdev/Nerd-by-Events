import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The three states every list screen needs, in one place so they can't drift.
 *
 * The empty state is the one people forget — a search that legitimately
 * returns nothing renders as a blank screen that's indistinguishable from a
 * bug, and it's the fastest way to make a working demo look broken.
 */

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function LoadingState({ label = 'Searching…' }: { label?: string }) {
  const theme = useTheme();
  return (
    <Centered>
      <ActivityIndicator color={theme.textSecondary} />
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </Centered>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const theme = useTheme();
  const message = error instanceof Error ? error.message : 'Something went wrong.';

  return (
    <Centered>
      <ThemedText type="subtitle" style={styles.emoji}>
        ⚠️
      </ThemedText>
      <ThemedText type="default">Couldn&apos;t load events</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
        {message}
      </ThemedText>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="smallBold">Try again</ThemedText>
        </Pressable>
      ) : null}
    </Centered>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <Centered>
      <ThemedText type="subtitle" style={styles.emoji}>
        🔍
      </ThemedText>
      <ThemedText type="default">{title}</ThemedText>
      {body ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
          {body}
        </ThemedText>
      ) : null}
    </Centered>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    minHeight: 240,
  },
  emoji: {
    lineHeight: 40,
  },
  body: {
    textAlign: 'center',
  },
  button: {
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
  },
});
