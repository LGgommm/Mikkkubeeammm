self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(clients.claim()));
// Revalidate the app shell when an installed app or a browser tab opens it.
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (request.mode !== 'navigate' || url.origin !== scope.origin ||
      ![scope.pathname, scope.pathname + 'index.html'].includes(url.pathname)) return;
  event.respondWith(fetch(request, {cache: 'no-cache'}).catch(() => fetch(request)));
});
self.addEventListener('push',event=>{
  let data={};
  try { data=event.data?.json() || {}; } catch {}
  event.waitUntil((async()=>{
    await self.registration.showNotification(data.title || '새 매물 알림',{
      body:data.body || '눌러서 새 매물을 확인하세요.',tag:data.tag || data.testId || 'market-alerts',
      ...(data.image ? {image:data.image,icon:data.image} : {}),data:{url:data.url}
    });
    for(const client of await clients.matchAll({type:'window',includeUncontrolled:true}))
      client.postMessage(data.testId ? {displayed:data.testId} : {type:'listing-added'});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  let target=self.registration.scope;
  try {
    const url=new URL(event.notification.data?.url);
    if(url.protocol==='https:' && ['jp.mercari.com','order.mandarake.co.jp','ekizo.mandarake.co.jp'].includes(url.hostname)) target=url.href;
  } catch {}
  event.waitUntil(clients.openWindow(target));
});