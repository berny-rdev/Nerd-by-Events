import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useState } from 'react';
import { useColorScheme } from 'react-native';

import { useNotificationRouting } from '@/hooks/use-notification-routing';
import { configureNotifications } from '@/lib/notifications';

// Foreground notification behaviour is global and set once, before render.
configureNotifications();

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Must live inside the navigator's tree so it can wait for the router to be
  // ready before pushing — see the cold-start note in the hook.
  useNotificationRouting();

  // Created in state, not at module scope: a module-level client would be
  // shared across Fast Refresh reloads and hold stale closures.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // RN has no window focus, so the web default of refetching on focus
            // does nothing useful here. AppState is the native equivalent.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="event/[id]"
            options={{ title: 'Event', headerBackButtonDisplayMode: 'minimal' }}
          />
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
