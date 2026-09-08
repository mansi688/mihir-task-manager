// Minimal service worker: enough to make the app installable (a requirement for real push
// notifications on most browsers) and to actually display a push notification when one arrives.
// Deliberately does NOT do offline caching of app pages — this app always needs a live
// connection to the server anyway (it's not designed to work offline), so caching would only
// risk showing stale data.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'MIHIR Task Manager', body: 'You have a new notification.', taskId: null };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) { /* fall back to default text above */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { taskId: data.taskId },
    })
  );
});

// Clicking the notification focuses an existing open tab if there is one, or opens a new one —
// rather than always spawning a new tab even when the app is already open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
