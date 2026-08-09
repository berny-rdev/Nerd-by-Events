import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { SourceBadges } from '@/components/source-badge';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatEventDate, formatPrice, formatVenue } from '@/lib/format';
import type { Event } from '@/sources/types';

/** Fixed height lets FlatList's getItemLayout skip measurement while scrolling. */
export const EVENT_CARD_HEIGHT = 108;

type Props = {
  event: Event;
  /** Rendered on the right — a save toggle on browse, a remove button on saved. */
  accessory?: React.ReactNode;
};

/**
 * `memo` matters here: FlatList re-renders rows whenever the parent re-renders,
 * and the search screen re-renders on every keystroke. Without it, typing
 * re-renders every visible card and the list stutters on a mid-range Android.
 */
export const EventCard = memo(function EventCard({ event, accessory }: Props) {
  const theme = useTheme();
  const price = formatPrice(event.price);

  return (
    <Link
      // Only the id crosses the navigation boundary. Route params end up in a
      // URL, so they must stay small and serializable — never pass the object.
      href={{ pathname: '/event/[id]', params: { id: event.id } }}
      asChild>
      <Pressable
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
        ]}>
        <Image
          source={event.imageUrl}
          style={styles.image}
          contentFit="cover"
          transition={150}
          // Sources return dead image URLs often enough that a placeholder
          // colour is the difference between a gap and a flash of white.
          placeholder={{ blurhash: 'L6PZfSjE.AyE_3t7t7R**0o#DgR4' }}
        />

        <View style={styles.body}>
          <ThemedText type="smallBold" numberOfLines={2}>
            {event.title}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {formatEventDate(event)}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {formatVenue(event)}
            {price ? ` · ${price}` : ''}
          </ThemedText>
          <SourceBadges event={event} />
        </View>

        {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
      </Pressable>
    </Link>
  );
});

const styles = StyleSheet.create({
  card: {
    height: EVENT_CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.two,
    borderRadius: Spacing.three,
  },
  image: {
    width: 84,
    height: 92,
    borderRadius: Spacing.two,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  accessory: {
    paddingRight: Spacing.two,
  },
});
