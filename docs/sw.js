self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(clients.claim()));
self.addEventListener('push',event=>{
  let data={};
  try { data=event.data?.json() || {}; } catch {}
  event.waitUntil((async()=>{
    await self.registration.showNotification(data.title || '새 매물 알림',{
      body:data.body || '눌러서 새 매물을 확인하세요.',tag:data.testId || 'market-alerts'
    });
    if(data.testId) for(const client of await clients.matchAll({type:'window',includeUncontrolled:true}))
      client.postMessage({displayed:data.testId});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(clients.openWindow(self.registration.scope));
});