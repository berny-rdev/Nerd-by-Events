import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';

import { useTheme } from '@/hooks/use-theme';

/**
 * File-based routing recap, because this is what interviews poke at:
 *
 *   src/app/_layout.tsx         -> root Stack
 *   src/app/(tabs)/_layout.tsx  -> this file; the parens mean "group without
 *                                  adding a URL segment", so index.tsx is `/`
 *                                  and not `/(tabs)`
 *   src/app/event/[id].tsx      -> dynamic route, pushed on top of the tabs
 *
 * The tab bar lives below the stack, so pushing an event detail covers it.
 */
export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.text,
        tabBarInactiveTintColor: theme.textSecondary,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Browse',
          tabBarIcon: ({ color, size }) => <Ionicons name="search" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: 'Saved',
          tabBarIcon: ({ color, size }) => <Ionicons name="heart" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
