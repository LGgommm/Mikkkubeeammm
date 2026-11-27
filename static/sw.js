self.addEventListener('push', event => {
  const {url,title} = event.data.json();
  event.waitUntil(self.registration.showNotification('나카노점 새 매물', {body:title,tag:url,data:url}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data));
});
