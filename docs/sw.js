self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('매물 알림', {
    body:'매물 알림이 도착했어요. 눌러서 목록을 확인하세요.',
    tag:'market-alerts'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(self.registration.scope));
});
