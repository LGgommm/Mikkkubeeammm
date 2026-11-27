const el = id => document.getElementById(id);
const shops = {mercari:'메루카리',nakano:'만다라케 나카노점'};
let key = localStorage.getItem('market-device');
if (!key) {
  key = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
  localStorage.setItem('market-device',key);
}
async function api(path, body) {
  if (!window.MARKET_API) throw Error('알림 서비스 배포를 기다리고 있어요.');
  const response = await fetch(window.MARKET_API + path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body && JSON.stringify(body)});
  if (!response.ok) throw Error('요청을 처리하지 못했어요 ('+response.status+').');
  return response.json();
}
function button(label, fn) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.onclick = () => run(fn);
  return btn;
}
function list(id,rows,make,empty) {
  el(id).replaceChildren(...(rows.length?rows.map(row=>{
    const li=document.createElement('li'); li.append(...make(row)); return li;
  }):[empty]));
}
function product(row) {
  const a=document.createElement('a');
  a.href=row.url;
  a.target='_blank';
  a.rel='noopener';
  const thumb=document.createElement('span');
  thumb.className='thumb';
  thumb.textContent='사진 없음';
  const title=document.createElement('span');
  title.className='item-title';
  const price=document.createElement('strong');
  const match=row.title.match(/ \(([\d,]+)円\)$/);
  title.textContent=match ? row.title.slice(0,match.index) : row.title;
  price.textContent=match ? '¥'+match[1] : '가격 확인';
  a.append(thumb,title,price);
  function photo(url) {
    const img=new Image();
    img.alt='';
    img.loading='lazy';
    img.onerror=()=>img.remove();
    img.src=url;
    thumb.append(img);
  }
  const url=new URL(row.url);
  const item=url.pathname.match(/^\/item\/(m\d+)$/);
  if (url.hostname==='jp.mercari.com' && item) photo('https://static.mercdn.net/item/detail/orig/photos/'+item[1]+'_1.jpg');
  if (url.hostname==='ekizo.mandarake.co.jp') {
    const observer=new IntersectionObserver(entries=>{
      if (!entries.some(entry=>entry.isIntersecting)) return;
      observer.disconnect();
      api('/auction-card?id='+encodeURIComponent(url.searchParams.get('index'))).then(data=>{
        if(data.image) photo(data.image);
        if(data.price) price.textContent='경매 '+data.price;
      }).catch(()=>{});
    });
    observer.observe(a);
  }
  return a;
}
async function refresh() {
  const {watches,hits,favorites}=await api('/state');
  const saved=new Set(favorites.map(row=>row.url));
  list('watches',watches,w=>[shops[w.shop]+' / '+w.keyword+' · '+(w.active?(w.initialized?'수집 중':'첫 수집 대기'):'중지'),button(w.active?'중지':'재개',()=>api('/toggle',{id:w.id,active:!w.active})),button('삭제',()=>confirm('이 키워드와 관련 알림을 삭제할까요?') && api('/delete',{id:w.id}))],'등록한 키워드가 없어요.');
  list('hits',hits,r=>[product(r),button(saved.has(r.url)?'찜 해제':'찜',()=>api('/favorite',{url:r.url,add:!saved.has(r.url)}))],'첫 수집 이후 발견한 새 매물이 여기에 표시돼요.');
  list('stars',favorites,r=>[product(r),button('찜 해제',()=>api('/favorite',{url:r.url,add:false}))],'찜한 매물이 없어요.');
  el('status').textContent='확인 '+new Date().toLocaleTimeString();
}
async function run(fn) {
  try {if(fn) await fn(); await refresh();} catch(e){el('status').textContent=e.message;}
}
el('form').onsubmit=e=>{e.preventDefault();run(async()=>{
  await api('/watch',{shop:el('shop').value,keyword:el('word').value}); el('word').value='';
});};
el('reload').onclick=()=>run();
run();
setInterval(()=>{if(!document.hidden) run();},60000);

async function setupPush() {
  const enable=el('enable-push'), test=el('test-push'), status=el('push-status');
  if(!enable) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    status.textContent='아이폰은 Safari에서 홈 화면에 추가한 뒤 홈 화면 아이콘으로 열어 주세요.';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    const reg=await navigator.serviceWorker.ready;
    const {key:publicKey}=await api('/push/key');
    const raw=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
    async function connected(sub) {
      await api('/push/subscribe',{endpoint:sub.endpoint});
      enable.hidden=true;
      test.hidden=false;
      status.textContent='이 기기에서 새 매물 푸시를 받아요.';
      test.onclick=async()=>{
        test.disabled=true;
        try {await api('/push/test',{endpoint:sub.endpoint});status.textContent='시험 알림을 발송했어요.';}
        catch {status.textContent='시험 알림 발송에 실패했어요. 알림 권한을 확인해 주세요.';}
        finally {test.disabled=false;}
      };
    }
    const sub=await reg.pushManager.getSubscription();
    if(sub) return await connected(sub);
    enable.hidden=false;
    enable.onclick=async()=>{
      enable.disabled=true;
      try {
        const permission=await Notification.requestPermission();
        if(permission!=='granted') throw Error('기기 설정에서 매물 알림을 허용해 주세요.');
        await connected(await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:raw}));
      } catch(e){status.textContent=e.message;}
      finally {enable.disabled=false;}
    };
  } catch {status.textContent='푸시 설정을 불러오지 못했어요. 다시 열어 주세요.';}
}
setupPush();
