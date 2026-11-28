const el = id => document.getElementById(id);
const shops = {mercari:'메루카리',nakano:'만다라케 나카노점'};
const validDeviceKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cookiePath = new URL('.', location.href).pathname;
function saveDeviceKey(value) {
  localStorage.setItem('market-device',value);
  document.cookie='market_device_backup='+value+'; Path='+cookiePath+'; Max-Age=31536000; Secure; SameSite=Strict';
}
const storedKey=localStorage.getItem('market-device');
const backupKey=document.cookie.split('; ').find(part=>part.startsWith('market_device_backup='))?.split('=')[1];
let key=validDeviceKey(storedKey) ? storedKey : backupKey;
if(!validDeviceKey(key)) key=Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
saveDeviceKey(key);
async function api(path, body, signal) {
  if (!window.MARKET_API) throw Error('알림 서비스 배포를 기다리고 있어요.');
  const response = await fetch(window.MARKET_API + path,{signal,cache:'no-store',method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body && JSON.stringify(body)});
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
function updateListingAge(time) {
  const minutes=Math.max(0,Math.floor((Date.now()/1000-Number(time.dataset.seconds))/60));
  const age=minutes<1?'방금':minutes<60?minutes+'분 전':minutes<1440?Math.floor(minutes/60)+'시간 전':Math.floor(minutes/1440)+'일 전';
  time.textContent=age+' '+time.dataset.kind;
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
  const source=document.createElement('small');
  source.className='source';
  const host=new URL(row.url).hostname;
  source.textContent=host==='jp.mercari.com' ? shops.mercari : ['ekizo.mandarake.co.jp','order.mandarake.co.jp'].includes(host) ? shops.nakano : host;
  const seconds=row.posted_at || row.found_at;
  if(seconds>0) {
    const time=document.createElement('time');
    time.dataset.seconds=seconds;
    time.dataset.kind=row.posted_at?'등록':'발견';
    time.dateTime=new Date(seconds*1000).toISOString();
    updateListingAge(time);
    source.append(' ',time);
  }
  a.append(thumb,title,price,source);
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
      auctionCard(url).then(data=>{
        if(data.image) photo(data.image);
        if(data.price) price.textContent='경매 '+data.price;
      }).catch(()=>{});
    });
    observer.observe(a);
  }
  return a;
}
const shopLogos = new Map(Array.from(document.querySelectorAll('#shop-menu input'), box =>
  [box.value, box.closest('label').querySelector('img').src]));
function watchControl(label, path, action) {
  const control = button(label, action);
  control.setAttribute('aria-label',label);
  control.title=label;
  control.innerHTML='<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="'+path+'"/></svg>';
  return control;
}
const form=el('editor-form');
for(const row of el('shop-menu').querySelectorAll('label')) {
  const copy=row.cloneNode(true);
  copy.querySelector('input').removeAttribute('name');
  el('edit-shops').append(copy);
}
let editing;
function foldEditor() {
  if(!editing) return;
  editing.button.setAttribute('aria-expanded','false');
  editing.panel.classList.remove('expanded');
  editing.panel.inert=true;
  editing=null;
}
const priceLimit=1000000;
const money=n=>n.toLocaleString('ko-KR');
function amount(id) {
  const raw=el(id).value.replaceAll(',','').trim();
  return /^\d+$/.test(raw)?Number(raw):NaN;
}
function syncRanges() {
  const a=el('range-low'), b=el('range-high');
  const min=amount('min-won'), max=amount('max-won');
  if(Number.isFinite(min)) a.value=String(min);
  if(Number.isFinite(max)) b.value=String(max);
  a.parentNode.style.setProperty('--lo',(100*a.value/priceLimit)+'%');
  a.parentNode.style.setProperty('--hi',(100*b.value/priceLimit)+'%');
  a.style.zIndex=Number(a.value)===Number(b.value) && Number(b.value)>0?'1':'';
  for(const id of ['min-won','max-won']) el(id).style.width=Math.max(2,el(id).value.length+.5)+'ch';
}
for(const id of ['min-won','max-won']) {
  const input=el(id);
  input.onfocus=()=>{input.value=input.value.replaceAll(',','');input.select();};
  input.oninput=syncRanges;
  input.onblur=()=>{const n=amount(id);if(Number.isSafeInteger(n)) input.value=money(n);syncRanges();};
}
el('range-low').oninput=event=>{
  const ceiling=amount('max-won');
  const n=Math.min(+event.target.value,Number.isFinite(ceiling)?Math.floor(ceiling/5000)*5000:priceLimit);
  el('min-won').value=money(Math.max(0,n));
  syncRanges();
};
el('range-high').oninput=event=>{
  const floor=amount('min-won');
  const n=Math.max(+event.target.value,Number.isFinite(floor)?Math.ceil(floor/5000)*5000:0);
  el('max-won').value=money(Math.min(priceLimit,n));
  syncRanges();
};
function editKeyword(keyword,rows,mode,panel,button) {
  const same=editing?.button===button;
  foldEditor();
  if(same) return;
  const dialog=el('keyword-dialog');
  if(!dialog.style.top) {
    dialog.style.top=Math.max(8,dialog.getBoundingClientRect().top)+'px';
    dialog.style.marginBlock='0';
    dialog.style.bottom='auto';
    dialog.style.maxHeight='calc(100dvh - '+dialog.style.top+' - 8px)';
  }
  panel.firstChild.append(form);
  panel.inert=false;
  editing={keyword,rows,mode,panel,button};
  button.setAttribute('aria-expanded','true');
  const price=mode==='price';
  el('edit-shops').hidden=price;
  el('edit-prices').hidden=!price;
  for(const box of el('edit-shops').querySelectorAll('input')) box.checked=rows.some(row=>row.shop===box.value);
  el('min-won').value=money(rows[0].min_krw??0);
  el('max-won').value=money(rows[0].max_krw??priceLimit);
  const legacy=rows[0].min_yen!=null || rows[0].max_yen!=null;
  el('editor-status').textContent=price && legacy?'기존 조건: '+(rows[0].min_yen??0)+' ~ '+(rows[0].max_yen??'제한 없음')+'엔. 저장하면 원화 조건으로 바뀌어요.':'';
  syncRanges();
  void panel.offsetHeight;
  panel.classList.add('expanded');
}
el('editor-cancel').onclick=foldEditor;
el('keyword-dialog').addEventListener('close',()=>{
  foldEditor();
  el('editor-parking').append(form);
  for(const property of ['top','bottom','margin-block','max-height']) el('keyword-dialog').style.removeProperty(property);
});
el('editor-form').onsubmit=async event=>{
  event.preventDefault();
  const {keyword,rows,mode}=editing;
  const save=event.submitter;
  if(save.disabled) return;
  save.disabled=true;
  try {
    if(mode==='price') {
      const min=amount('min-won'), max=amount('max-won');
      if(![min,max].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=priceLimit)) throw Error('0원부터 1,000,000원 사이의 금액을 입력해 주세요.');
      if(min>max) throw Error('최대 가격은 최소 가격 이상이어야 해요.');
      await api('/keyword-price',{keyword,min,max,currency:'KRW'});
    } else {
      const shops=Array.from(el('edit-shops').querySelectorAll(':checked'),box=>box.value);
      if(!shops.length) throw Error('상점을 하나 이상 선택해 주세요.');
      if(rows.some(row=>!shops.includes(row.shop)) && !confirm('선택 해제한 상점의 이 키워드와 관련 알림을 삭제할까요?')) return;
      await api('/keyword-shops',{keyword,shops});
    }
    foldEditor();
    await run();
  } catch(e){el('editor-status').textContent=e.message;}
  finally {save.disabled=false;}
};
function watchCard([keyword, rows]) {
  const logos=document.createElement('span');
  logos.className='watch-logos';
  for(const shop of new Set(rows.map(row=>row.shop))) {
    const logo=new Image();
    logo.alt=shops[shop] || shop;
    logo.src=shopLogos.get(shop);
    logos.append(logo);
  }
  const name=document.createElement('span');
  name.className='watch-keyword';
  name.textContent=keyword;
  let pause=rows.some(row=>row.active);
  async function apply(targets, path, body) {
    const results=await Promise.allSettled(targets.map(row=>api(path,body(row))));
    const failed=results.some(result=>result.status==='rejected');
    el('watch-feedback').textContent=failed?'일부 상점에 반영하지 못했어요. 목록을 확인해 주세요.':'';
    return !failed;
  }
  const toggle=watchControl(keyword+(pause?' 일시정지':' 재개'),pause?'M5 3v10M11 3v10':'M5 3l8 5-8 5z',
    async ()=>{
      toggle.disabled=true;
      try {
        const ok=await apply(rows.filter(row=>Boolean(row.active)===pause),'/toggle',row=>({id:row.id,active:!pause}));
        if(ok) {
          for(const row of rows) row.active=!pause;
          pause=!pause;
          const label=keyword+(pause?' 일시정지':' 재개');
          toggle.title=label;
          toggle.setAttribute('aria-label',label);
          toggle.querySelector('path').setAttribute('d',pause?'M5 3v10M11 3v10':'M5 3l8 5-8 5z');
        }
      } finally {toggle.disabled=false;}
    });
  const remove=watchControl(keyword+' 삭제','M4 4l8 8M12 4l-8 8',()=>{
    if(confirm('등록한 모든 상점에서 이 키워드와 관련 알림을 삭제할까요?'))
      return apply(rows,'/delete',row=>({id:row.id}));
  });
  const options=document.createElement('div');
  options.className='watch-options';
  const panel=document.createElement('div');
  panel.className='watch-panel'; panel.inert=true;
  const body=document.createElement('div');
  body.className='panel-body'; panel.append(body);
  for(const [label,mode] of [['상점 선택','shops'],['가격','price']]) {
    const control=document.createElement('button');
    control.type='button';
    control.textContent=label;
    control.setAttribute('aria-expanded','false');
    control.onclick=()=>editKeyword(keyword,rows,mode,panel,control);
    options.append(control);
  }
  return [logos,name,toggle,remove,options,panel];
}
const productSnapshots=new Map();
function productList(id,rows,make,empty,signature) {
  const snapshot=JSON.stringify(signature);
  if(productSnapshots.get(id)===snapshot) return;
  list(id,rows,make,empty);
  productSnapshots.set(id,snapshot);
}
let watchSnapshot;
let feedHits=[], feedSaved=new Set(), availableWords=[];
const selectedShops=new Set(Object.keys(shops)), selectedWords=new Set();
const auctionCards=new Map();
function auctionCard(url) {
  const id=url.searchParams.get('index');
  if(!auctionCards.has(id) || Date.now()-auctionCards.get(id).at>60000){
    const entry={at:Date.now()};
    entry.request=api('/auction-card?id='+encodeURIComponent(id)).then(card=>{
      entry.yen=Number((card.price || '').replaceAll(',','').match(/^([0-9]+)円$/)?.[1]);
      return card;
    }).catch(error=>{auctionCards.delete(id);throw error;});
    auctionCards.set(id,entry);
  }
  return auctionCards.get(id).request;
}
function choiceButtons(id,values,selected) {
  const box=el(id);
  box.replaceChildren();
  for(const [value,label] of [[null,'전체'],...values]){
    const b=document.createElement('button');
    b.type='button'; b.textContent=label;
    b.setAttribute('aria-pressed',String(value===null ? selected.size===0 : selected.has(value)));
    b.onclick=()=>{
      if(value===null) selected.clear();
      else if(selected.has(value)) selected.delete(value);
      else selected.add(value);
      choiceButtons(id,values,selected);
      renderFeed();
    };
    box.append(b);
  }
}
function showChoices(){
  const box=el('filter-shops');
  if(!box.childElementCount) {
    for(const label of el('shop-menu').querySelectorAll('label')) {
      const copy=label.cloneNode(true);
      const input=copy.querySelector('input');
      input.removeAttribute('name');
      input.onchange=()=>{
        if(input.checked) selectedShops.add(input.value);
        else selectedShops.delete(input.value);
        renderFeed();
      };
      box.append(copy);
    }
  }
  for(const input of box.querySelectorAll('input')) input.checked=selectedShops.has(input.value);
  choiceButtons('filter-words',availableWords.map(word=>[word,word]),selectedWords);
}
if(el('feed-filter')) {
el('feed-filter').onclick=()=>{showChoices();el('filter-dialog').showModal();};
el('filter-close').onclick=()=>el('filter-dialog').close();
el('filter-done').onclick=()=>{
  if(el('filter-min').reportValidity() && el('filter-max').reportValidity()) el('filter-dialog').close();
};
el('filter-reset').onclick=()=>{
  for(const shop of Object.keys(shops)) selectedShops.add(shop);
  selectedWords.clear();
  el('filter-min').value=el('filter-max').value='';
  showChoices();renderFeed();
};
el('filter-min').oninput=el('filter-max').oninput=renderFeed;
}
let priceLookupRunning=false;
async function fillAuctionPrices(urls) {
  if(priceLookupRunning || !urls.length) return;
  priceLookupRunning=true;
  await Promise.allSettled(urls.slice(0,4).map(url=>auctionCard(new URL(url))));
  priceLookupRunning=false;
  // Continue only after a successful lookup; a subsequent poll retries failures.
  if(urls.slice(0,4).some(url=>auctionCards.has(new URL(url).searchParams.get('index')))) renderFeed();
}
function renderFeed(){
  const min=el('filter-min'),max=el('filter-max');
  const byPrice=Boolean(min && (min.value!=='' || max.value!==''));
  const inverted=byPrice && min.value!=='' && max.value!=='' && min.valueAsNumber>max.valueAsNumber;
  max?.setCustomValidity(inverted?'최고가는 최저가 이상으로 입력해 주세요.':'');
  const active=Boolean(byPrice || selectedShops.size!==Object.keys(shops).length || selectedWords.size);
  el('feed-filter')?.classList.toggle('active',active);
  const unknown=[], hits=feedHits.filter(row=>{
    if(!selectedShops.has(row.shop)) return false;
    if(selectedWords.size && !selectedWords.has(row.keyword)) return false;
    if(!byPrice) return true;
    const amount=row.title.match(/([\d,]+)\s*円\)?$/);
    let yen=amount ? Number(amount[1].replaceAll(',','')) : NaN;
    if(!amount && row.url.startsWith('https://ekizo.mandarake.co.jp/')){
      const entry=auctionCards.get(new URL(row.url).searchParams.get('index'));
      yen=entry?.yen;
      if(yen===undefined || Date.now()-entry.at>60000) unknown.push(row.url);
    }
    return Number.isFinite(yen) && (!min.value || yen>=min.valueAsNumber) && (!max.value || yen<=max.valueAsNumber);
  });
  const saved=feedSaved;
  const empty=active ? (unknown.length?'가격 확인 중…':'선택한 조건에 맞는 매물이 없어요.') : '첫 수집 이후 발견한 새 매물이 여기에 표시돼요.';
  productList('hits',hits,r=>[product(r),button(saved.has(r.url)?'찜 해제':'찜',()=>api('/favorite',{url:r.url,add:!saved.has(r.url)}))],empty,[empty,...hits.map(r=>[r.url,r.title,r.posted_at,r.found_at,saved.has(r.url)])]);
  if(el('filter-done')) el('filter-done').textContent=hits.length+'개 보기';
  if(!inverted) void fillAuctionPrices([...new Set(unknown)]);
}

let latestRefresh=0;
async function refresh() {
  const request=++latestRefresh;
  let state;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try {state=await api('/state',undefined,controller.signal);}
  catch(error) {
    if(request!==latestRefresh) return;
    if(controller.signal.aborted) throw Error('목록 응답이 늦어 다시 확인할게요.');
    throw error;
  } finally {clearTimeout(timeout);}
  if(request!==latestRefresh) return;
  const {watches,hits,favorites}=state;
  const saved=new Set(favorites.map(row=>row.url));
  const groups=new Map();
  for(const watch of watches) {
    if(!groups.has(watch.keyword)) groups.set(watch.keyword,[]);
    groups.get(watch.keyword).push(watch);
  }
  const nextWatchSnapshot=JSON.stringify(watches);
  if(!editing && watchSnapshot!==nextWatchSnapshot) {
    el('editor-parking').append(form);
    list('watches',Array.from(groups),watchCard,'등록한 키워드가 없어요.');
    watchSnapshot=nextWatchSnapshot;
  }
  feedHits=hits;
  feedSaved=saved;
  availableWords=[...new Set([...groups.keys(),...hits.map(row=>row.keyword)].filter(Boolean))];
  renderFeed();
  productList('stars',favorites,r=>[product(r),button('찜 해제',()=>api('/favorite',{url:r.url,add:false}))],'찜한 매물이 없어요.',favorites.map(r=>[r.url,r.title,r.posted_at,r.found_at]));
  document.querySelectorAll('.source time').forEach(updateListingAge);
  el('status').textContent='확인 '+new Date().toLocaleTimeString();
}
async function run(fn) {
  try {if(fn) await fn(); await refresh();} catch(e){el('status').textContent=e.message;}
}
el('form').onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  if(form.dataset.saving) return;
  const boxes=Array.from(form.querySelectorAll('input[name="shops"]:checked'));
  const keyword=el('word').value.trim();
  if(!keyword || !boxes.length) return;
  const feedback=el('watch-feedback');
  form.dataset.saving='true';
  feedback.textContent='등록 중…';
  try {
    const results=await Promise.allSettled(boxes.map(box=>api('/watch',{shop:box.value,keyword})));
    const failed=boxes.filter((box,i)=>results[i].status==='rejected');
    feedback.textContent=failed.length
      ? '등록 실패 · '+failed.map(box=>shops[box.value]).join(', ')+'. 다시 눌러 주세요.'
      : boxes.map(box=>shops[box.value]).join(', ')+'에 등록했어요.';
    if(!failed.length && el('word').value.trim()===keyword) el('word').value='';
    await run();
  } finally {delete form.dataset.saving;}
};
el('reload').onclick=async event=>{
  const control=event.currentTarget;
  control.disabled=true;
  control.setAttribute('aria-busy','true');
  el('status').textContent='확인 중…';
  try { await run(); }
  finally { control.disabled=false; control.removeAttribute('aria-busy'); }
};
let pollTimer;
let pollGeneration=0;
function scheduleRefresh() {
  const generation=++pollGeneration;
  clearTimeout(pollTimer);
  if(document.hidden) return;
  async function poll() {
    await run();
    if(generation===pollGeneration && !document.hidden) pollTimer=setTimeout(poll,10000);
  }
  pollTimer=setTimeout(poll,0);
}
navigator.serviceWorker?.addEventListener('message',event=>{
  if(event.data?.type==='listing-added' && !document.hidden) scheduleRefresh();
});
document.addEventListener('visibilitychange',scheduleRefresh);
window.addEventListener('pageshow',event=>{if(event.persisted) scheduleRefresh();});
window.addEventListener('online',scheduleRefresh);
scheduleRefresh();

async function setupPush() {
  const enable=el('enable-push'), test=el('test-push'), status=el('push-status');
  if(!enable) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    status.textContent='아이폰은 Safari에서 홈 화면에 추가한 뒤 홈 화면 아이콘으로 열어 주세요.';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
    const reg=await navigator.serviceWorker.ready;
    const {key:publicKey}=await api('/push/key');
    const raw=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
    async function connected(sub) {
      await api('/push/subscribe',sub.toJSON());
      enable.hidden=true;
      test.hidden=false;
      status.textContent='이 기기에서 새 매물 푸시를 받아요.';
      let pendingTest=null, displayed=null;
      navigator.serviceWorker.addEventListener('message',event=>{
        if(pendingTest && event.data?.displayed===pendingTest) {
          displayed=pendingTest;
          status.textContent='이 기기에서 시험 알림 표시 요청을 완료했어요.';
        }
      });
      test.onclick=async()=>{
        test.disabled=true;
        try {
          pendingTest=crypto.randomUUID();
          const result=await api('/push/test',{endpoint:sub.endpoint,testId:pendingTest});
          if(!result.accepted) {
            if([404,410].includes(result.providerStatus) || ['VapidPkHashMismatch','BadDeviceToken'].includes(result.reason)) {
              await sub.unsubscribe();
              test.hidden=true;
              location.reload();
            } else if(result.stage==='empty') status.textContent='아직 수집된 매물이 없어요. 첫 수집 후 다시 눌러 주세요.';
            else if(result.stage==='subscription') status.textContent='기기 구독을 다시 연결해 주세요.';
            else if(result.stage==='network') status.textContent='서버에서 푸시 서비스에 연결하지 못했어요. 잠시 후 다시 눌러 주세요.';
            else if(result.stage==='prepare') status.textContent='서버 메시지 준비 실패 ('+result.error+').';
            else status.textContent='푸시 서비스 응답: HTTP '+result.providerStatus+(result.reason?' / '+result.reason:'');
          } else if(displayed!==pendingTest) status.textContent='푸시 서비스 접수 완료 · 기기 수신 대기 중';
        }
        catch(e) {status.textContent='시험 요청 오류: '+e.message;}
        finally {test.disabled=false;}
      };
    }
    let sub=await reg.pushManager.getSubscription();
    if(sub?.options.applicationServerKey && !raw.every((v,i)=>new Uint8Array(sub.options.applicationServerKey)[i]===v)) {
      await sub.unsubscribe();
      sub=null;
    }
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

el('backup-key')?.addEventListener('click',async()=>{
  const status=el('backup-status');
  try { await navigator.clipboard.writeText(key); status.textContent='복구코드를 복사했어요. 안전한 곳에 보관하세요.'; }
  catch {const input=el('restore-code');input.value=key;input.type='text';input.focus();input.select();status.textContent='선택된 복구코드를 복사하세요.';}
});
el('restore-key')?.addEventListener('click',async()=>{
  const input=el('restore-code'), candidate=input.value.trim(), status=el('backup-status');
  if(!validDeviceKey(candidate)){status.textContent='복구코드 64자리를 확인해 주세요.';return;}
  try {
    const response=await fetch(window.MARKET_API+'/state',{headers:{Authorization:'Bearer '+candidate}});
    if(!response.ok) throw Error();
    const data=await response.json();
    if(!data.watches.length && !data.hits.length && !data.favorites.length){status.textContent='이 코드에 저장된 목록이 없어요.';return;}
    if(candidate!==key && !confirm('이 브라우저에서 복구한 목록을 열까요? 현재 목록으로 돌아오려면 현재 복구코드를 보관해 주세요.')) return;
    const reg=await navigator.serviceWorker?.getRegistration();
    const subscription=await reg?.pushManager?.getSubscription();
    if(candidate!==key && subscription) await subscription.unsubscribe();
    saveDeviceKey(candidate);
    location.reload();
  } catch {status.textContent='목록을 확인하지 못했어요. 다시 시도해 주세요.';}
});
