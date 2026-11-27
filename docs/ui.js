const el = id => document.getElementById(id);
let publicKey;
el('server').value = localStorage.getItem('server') || '';
async function api(path, data) {
  const server = new URL(el('server').value);
  if (server.protocol !== 'https:') throw Error('HTTPS 서버 주소를 입력해 주세요.');
  const response = await fetch(server.origin + '/api/' + path, {
    redirect: 'error',
    method: data ? 'POST' : 'GET',
    headers: {Authorization: 'Bearer ' + el('key').value, 'Content-Type': 'application/json'},
    body: data ? JSON.stringify(data) : undefined
  });
  if (!response.ok) throw Error(response.status === 401 ? '접속 키를 확인해 주세요.' : '요청 실패 (' + response.status + ')');
  if (response.status !== 204) return response.json();
}
async function refresh(loadWords) {
  const {meta, hits, publicKey: key} = await api('state');
  publicKey = key;
  if (loadWords) el('words').value = meta.words || '';
  el('status').textContent = [meta.error, meta.success ? '마지막 성공 ' + new Date(meta.success * 1000).toLocaleString() : '첫 수집 대기 중'].filter(Boolean).join(' / ');
  el('hits').replaceChildren(...hits.map(([title, url]) => {
    const li = document.createElement('li'), a = document.createElement('a');
    a.textContent = title; a.href = url; li.append(a); return li;
  }));
  document.querySelector('main').hidden = false;
}
function action(id, fn) {
  el(id).onclick = async () => {
    try { el('msg').textContent = await fn() || ''; }
    catch (error) { el('msg').textContent = error.message; }
  };
}
action('connect', async () => {await refresh(true); localStorage.setItem('server', new URL(el('server').value).origin);});
action('save', async () => {await api('words', {words: el('words').value}); return '검색어를 저장했어요.';});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(e => el('msg').textContent = e.message);
action('push', async () => {
  if (!('PushManager' in window)) throw Error('아이폰에서는 Safari에서 홈 화면에 추가한 후 열어 주세요.');
  if (await Notification.requestPermission() !== 'granted') throw Error('알림 권한을 확인해 주세요.');
  const reg = await navigator.serviceWorker.ready;
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:bytes});
  await api('device',sub.toJSON()); return '이 기기의 입고 알림을 켰어요.';
});
setInterval(() => {if (!document.querySelector('main').hidden) refresh(false).catch(e => el('msg').textContent=e.message);},60000);
