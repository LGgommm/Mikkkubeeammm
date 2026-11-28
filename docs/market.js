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
  if (!response.ok) throw Object.assign(Error('요청을 처리하지 못했어요 ('+response.status+').'),{status:response.status});
  return response.json();
}
function button(label, fn) {
  const btn = document.createElement('button');
  btn.type='button';
  btn.className='ios-button';
  btn.textContent = label;
  btn.onclick = () => run(fn);
  return btn;
}
function controlIcon(path) {
  return '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="'+path+'"/></svg>';
}
function iconButton(label,path,action) {
  const control=button(label,action);
  control.classList.add('ios-button--icon');
  control.setAttribute('aria-label',label);
  control.title=label;
  control.innerHTML=controlIcon(path);
  return control;
}
function favoriteButton(row,saved) {
  const control=iconButton(saved?'찜 해제':'찜',
    'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z',
    ()=>api('/favorite',{url:row.url,add:!saved}));
  control.classList.add('favorite-button');
  control.setAttribute('aria-pressed',String(saved));
  return control;
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
const expandedProducts=new Set();
const reduceListingMotion=matchMedia('(prefers-reduced-motion: reduce)');
const listingTransition={duration:420,easing:'cubic-bezier(.25,.65,.35,1)'};
const descriptionTransition={duration:200,easing:'ease-out'};
const productDetails=new Map();
function listingDetails(url,original=false) {
  const key=url+(original?' original':' translation');
  if(!productDetails.has(key)) {
    const request=api('/listing-details?url='+encodeURIComponent(url)+(original?'&original=1':''),
      undefined,AbortSignal.timeout(original?10000:35000))
      .then(detail=>{
        if(!detail.description || (!detail.translated && !detail.needsTranslation)) productDetails.delete(key);
        return detail;
      })
      .catch(error=>{productDetails.delete(key);throw error;});
    productDetails.set(key,request);
  }
  return productDetails.get(key);
}
function product(row,listId) {
  const key=JSON.stringify([listId,row.keyword,row.url]);
  const card=document.createElement('div');
  card.className='listing-card';
  const layout=document.createElement('div');
  layout.className='listing-layout';
  const toggle=document.createElement('button');
  toggle.type='button';
  toggle.className='listing-toggle';
  const toggleLabel=document.createElement('span');
  toggleLabel.className='listing-toggle-label ios-button ios-button--compact ios-button--neutral';
  toggle.append(toggleLabel);
  const a=document.createElement('a');
  a.href=row.url;
  a.target='_blank';
  a.rel='noopener';
  a.className='listing-original ios-button ios-button--compact';
  a.innerHTML='원본 페이지'+controlIcon('M13 5h6v6m0-6-8 8M10 6H5v13h13v-5');
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
  source.textContent=host==='jp.mercari.com' ? shops.mercari : ['ekizo.mandarake.co.jp','order.mandarake.co.jp'].includes(host) ? (row.shop==='nakano' ? shops.nakano : '만다라케') : host;
  const seconds=row.posted_at || row.found_at;
  if(seconds>0) {
    const time=document.createElement('time');
    time.dataset.seconds=seconds;
    time.dataset.kind=row.posted_at?'등록':'발견';
    time.dateTime=new Date(seconds*1000).toISOString();
    updateListingAge(time);
    source.append(' ',time);
  }
  const auction=host==='ekizo.mandarake.co.jp';
  if(auction) {
    const label=document.createElement('span');
    label.className='auction-label';
    label.textContent='경매 상품';
    source.prepend(label,' ');
  }
  if(row.catalogue_available===0) source.append(' · 품절');
  if('stock_available' in row && host==='order.mandarake.co.jp') {
    source.append(' · '+(row.stock_available===0?'품절 · 재입고 알림 대기':row.stock_available===1?'마지막 확인 시 재고 있음':'재입고 확인 대기'));
  }
  const description=document.createElement('section');
  description.className='listing-description';
  const heading=document.createElement('h3');
  heading.textContent='상품 설명';
  const text=document.createElement('p');
  description.append(heading,text);
  layout.append(toggle,thumb,title,a,price,source,description);
  card.append(layout);

  let heightAnimation, movements=[], pendingDescription;
  function setDescription(update) {
    if(card.classList.contains('animating')) {
      const previous=pendingDescription;
      pendingDescription=()=>{
        previous?.();
        update();
      };
    } else {
      animateLayout(update);
    }
  }
  function finishLayout() {
    card.classList.remove('animating');
    const update=pendingDescription;
    pendingDescription=undefined;
    if(update) animateLayout(update);
  }

  function animateLayout(update,moveContents=false) {
    const image=thumb.querySelector('img');
    const canAnimate=!reduceListingMotion.matches && card.getClientRects().length>0;
    const targets=canAnimate && moveContents
      ? [image?.naturalWidth ? image : null,title,price,source].filter(Boolean)
      : [];
    const positions=targets.map(element=>element.getBoundingClientRect());
    const fromHeight=canAnimate ? card.offsetHeight : 0;

    heightAnimation?.cancel();
    heightAnimation=undefined;
    if(moveContents || !canAnimate) {
      movements.forEach(animation=>animation.cancel());
      movements=[];
    }
    update();
    if(!canAnimate) {
      finishLayout();
      return;
    }

    const toHeight=layout.getBoundingClientRect().height;
    const endPositions=targets.map(element=>element.getBoundingClientRect());
    if(Math.abs(fromHeight-toHeight)>1) {
      card.classList.add('animating');
      const animation=card.animate(
        [{height:fromHeight+'px'},{height:toHeight+'px'}],
        moveContents ? listingTransition : descriptionTransition
      );
      heightAnimation=animation;
      animation.onfinish=()=>{
        if(heightAnimation===animation) {
          heightAnimation=undefined;
          finishLayout();
        }
      };
    } else {
      finishLayout();
    }

    for(const [index,element] of targets.entries()) {
      const before=positions[index],after=endPositions[index];
      if(!after.width || !after.height) continue;
      const dx=before.left-after.left,dy=before.top-after.top;
      const scale=element===image ? ` scale(${before.width/after.width},${before.height/after.height})` : '';
      movements.push(element.animate([
        {transformOrigin:'top left',transform:`translate3d(${dx}px,${dy}px,0)${scale}`},
        {transformOrigin:'top left',transform:'none'}
      ],listingTransition));
    }
  }

  let loading=false, detailRetry;
  function showExpanded(open) {
    card.classList.toggle('expanded',open);
    toggle.setAttribute('aria-expanded',String(open));
    toggle.setAttribute('aria-label',(open?'접기: ':'상세 보기: ')+title.textContent);
    toggleLabel.hidden=!open;
    toggleLabel.textContent=open?'접기':'';
    a.hidden=description.hidden=!open;
    clearTimeout(detailRetry);
    if(!open || loading) return;
    loading=true;
    heading.textContent='상품 설명';
    text.textContent='상품 설명 불러오는 중…';
    function showDescription(detail) {
      setDescription(()=>{
        heading.textContent=detail.needsTranslation?'상품 설명 (번역 중)':detail.translated?'상품 설명':'상품 설명 (원문)';
        text.textContent=detail.description+(detail.shortened?'\n\n나머지 설명은 원본 페이지에서 확인해 주세요.':'');
      });
    }
    listingDetails(row.url,true).then(async detail=>{
      if(!detail.description) {
        setDescription(()=>{
          text.textContent=detail.pending?'상품 설명을 확인하고 있어요. 잠시 후 자동으로 다시 확인해요.':'원본 페이지에서 상품 설명을 확인해 주세요.';
        });
        if(detail.pending && card.classList.contains('expanded')) {
          detailRetry=setTimeout(()=>{
            if(card.isConnected && card.classList.contains('expanded')) showExpanded(true);
          },5000);
        }
        return;
      }
      showDescription(detail);
      if(!detail.needsTranslation) return;
      try {showDescription(await listingDetails(row.url));}
      catch {setDescription(()=>{heading.textContent='상품 설명 (원문)';});}
    }).catch(()=>{
      setDescription(()=>{
        text.textContent='설명을 불러오지 못했어요. 카드를 접었다 다시 열면 재시도해요.';
      });
    }).finally(()=>{loading=false;});
  }
  toggle.onclick=()=>{
    const open=toggle.getAttribute('aria-expanded')==='false';
    if(open) expandedProducts.add(key);
    else expandedProducts.delete(key);
    animateLayout(()=>showExpanded(open),true);
  };
  showExpanded(expandedProducts.has(key));
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
  if (row.image && url.hostname==='order.mandarake.co.jp') photo(row.image);
  if (url.hostname==='jp.mercari.com' && item) photo('https://static.mercdn.net/item/detail/orig/photos/'+item[1]+'_1.jpg');
  if (auction) {
    const observer=new IntersectionObserver(entries=>{
      if (!entries.some(entry=>entry.isIntersecting)) return;
      observer.disconnect();
      auctionCard(url).then(data=>{
        if(data.image) photo(data.image);
        if(data.price) price.textContent='경매 '+data.price;
      }).catch(()=>{});
    });
    observer.observe(thumb);
  }
  return card;
}
const shopLogos = new Map(Array.from(document.querySelectorAll('#shop-menu input'), box =>
  [box.value, box.closest('label').querySelector('img').src]));
const form=el('editor-form');
for(const row of el('shop-menu').querySelectorAll('label')) {
  const copy=row.cloneNode(true);
  copy.querySelector('input').removeAttribute('name');
  el('edit-shops').append(copy);
}
const shopBoxes=Array.from(el('edit-shops').querySelectorAll('input'));
let editing, pendingShopSave;
function restoreShopChoices(rows) {
  for(const box of shopBoxes) box.checked=rows.some(row=>row.shop===box.value);
}
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
function editKeyword(keyword,rows,mode,panel,button,updateRows) {
  if(pendingShopSave) return;
  const same=editing?.button===button;
  foldEditor();
  if(same) return;
  panel.firstChild.append(form);
  panel.inert=false;
  editing={keyword,rows,mode,panel,button,updateRows};
  button.setAttribute('aria-expanded','true');
  const price=mode==='price';
  el('edit-shops').hidden=price;
  el('edit-prices').hidden=!price;
  el('price-actions').hidden=!price;
  restoreShopChoices(rows);
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
});
el('edit-shops').onchange=async ()=>{
  const editor=editing;
  if(editor?.mode!=='shops' || pendingShopSave) return;
  const status=el('editor-status');
  const selected=shopBoxes.filter(box=>box.checked).map(box=>box.value);
  status.textContent='';
  if(!selected.length) {
    restoreShopChoices(editor.rows);
    status.textContent='상점을 하나 이상 선택해 주세요.';
    return;
  }
  if(editor.rows.some(row=>!selected.includes(row.shop)) && !confirm('선택 해제한 상점의 이 키워드와 관련 알림을 삭제할까요?')) {
    restoreShopChoices(editor.rows);
    return;
  }
  pendingShopSave=editor;
  for(const box of shopBoxes) box.disabled=true;
  status.textContent='상점 선택 반영 중…';
  try {
    await api('/keyword-shops',{keyword:editor.keyword,shops:selected},AbortSignal.timeout(15000));
  } catch {
    pendingShopSave=null;
    for(const box of shopBoxes) box.disabled=false;
    if(editing===editor) {
      restoreShopChoices(editor.rows);
      status.textContent='상점을 변경하지 못했어요. 다시 선택해 주세요.';
    }
    return;
  }
  editor.saved=true;
  await run();
  if(pendingShopSave===editor && editing===editor)
    status.textContent='상점을 변경했어요. 선택 목록을 다시 불러오는 중이에요.';
};
form.onsubmit=async event=>{
  event.preventDefault();
  const editor=editing;
  if(editor?.mode!=='price') return;
  const save=form.querySelector('button[type="submit"]');
  if(save.disabled) return;
  save.disabled=true;
  try {
    const min=amount('min-won'), max=amount('max-won');
    if(![min,max].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=priceLimit)) throw Error('0원부터 1,000,000원 사이의 금액을 입력해 주세요.');
    if(min>max) throw Error('최대 가격은 최소 가격 이상이어야 해요.');
    await api('/keyword-price',{keyword:editor.keyword,min,max,currency:'KRW'});
    if(editing===editor) foldEditor();
    await run();
  } catch(e){if(editing===editor) el('editor-status').textContent=e.message;}
  finally {save.disabled=false;}
};
function watchCard([keyword, rows]) {
  const logos=document.createElement('span');
  logos.className='watch-logos';
  function renderLogos() {
    logos.replaceChildren(...Array.from(new Set(rows.map(row=>row.shop)),shop=>{
      const logo=new Image();
      logo.alt=shops[shop] || shop;
      logo.src=shopLogos.get(shop);
      return logo;
    }));
  }
  renderLogos();
  const name=document.createElement('span');
  name.className='watch-keyword';
  name.textContent=keyword;
  const togglePath=pause=>pause?'M9 5v14m6-14v14':'M8 5l11 7-11 7Z';
  const toggleLabel=pause=>keyword+(pause?' 일시정지':' 재개');
  const isActive=()=>rows.some(row=>row.active);
  function updateToggle() {
    const active=isActive();
    toggle.title=toggleLabel(active);
    toggle.setAttribute('aria-label',toggle.title);
    toggle.querySelector('path').setAttribute('d',togglePath(active));
  }
  function updateRows(nextRows) {
    rows.splice(0,rows.length,...nextRows);
    renderLogos();
    updateToggle();
  }
  async function apply(targets, path, body) {
    const results=await Promise.allSettled(targets.map(row=>api(path,body(row))));
    const failed=results.some(result=>result.status==='rejected');
    el('watch-feedback').textContent=failed?'일부 상점에 반영하지 못했어요. 목록을 확인해 주세요.':'';
    return !failed;
  }
  const toggle=iconButton(toggleLabel(isActive()),togglePath(isActive()),async ()=>{
      if(pendingShopSave) return;
      const pause=isActive();
      toggle.disabled=true;
      try {
        const ok=await apply(rows.filter(row=>Boolean(row.active)===pause),'/toggle',row=>({id:row.id,active:!pause}));
        if(ok) {
          for(const row of rows) row.active=!pause;
          updateToggle();
        }
      } finally {toggle.disabled=false;}
    });
  const remove=iconButton(keyword+' 삭제','M7 7l10 10M17 7 7 17',()=>{
    if(!pendingShopSave && confirm('등록한 모든 상점에서 이 키워드와 관련 알림을 삭제할까요?'))
      return apply(rows,'/delete',row=>({id:row.id}));
  });
  remove.classList.add('ios-button--destructive');
  const actions=document.createElement('div');
  actions.className='watch-actions';
  actions.append(toggle,remove);
  const options=document.createElement('div');
  options.className='watch-options';
  const panel=document.createElement('div');
  panel.className='watch-panel'; panel.inert=true;
  const body=document.createElement('div');
  body.className='panel-body'; panel.append(body);
  for(const [label,mode] of [['상점 선택','shops'],['가격','price']]) {
    const control=document.createElement('button');
    control.type='button';
    control.className='ios-button ios-button--compact ios-button--option';
    control.textContent=label;
    control.setAttribute('aria-expanded','false');
    control.onclick=()=>editKeyword(keyword,rows,mode,panel,control,updateRows);
    options.append(control);
  }
  return [logos,name,actions,options,panel];
}
const productSnapshots=new Map();
const pendingProductRenders=new Map();
function productList(id,rows,make,empty,signature) {
  clearTimeout(pendingProductRenders.get(id));
  pendingProductRenders.delete(id);
  const snapshot=JSON.stringify(signature);
  if(productSnapshots.get(id)===snapshot) return;
  if(el(id).querySelector('.listing-card.animating')) {
    pendingProductRenders.set(id,setTimeout(()=>productList(id,rows,make,empty,signature),80));
    return;
  }
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
    b.type='button';
    b.className='ios-button ios-button--compact ios-button--option';
    b.textContent=label;
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
  el('feed-filter')?.setAttribute('aria-pressed',String(active));
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
  productList('hits',hits,r=>[product(r,'hits'),favoriteButton(r,saved.has(r.url))],empty,[empty,...hits.map(r=>[r.url,r.title,r.posted_at,r.found_at,r.image,r.catalogue_available,saved.has(r.url)])]);
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
  if(pendingShopSave?.saved) {
    const editor=pendingShopSave;
    pendingShopSave=null;
    for(const box of shopBoxes) box.disabled=false;
    if(editing===editor) {
      const rows=groups.get(editor.keyword);
      if(rows?.length) {
        editor.updateRows(rows);
        restoreShopChoices(editor.rows);
        el('editor-status').textContent='';
      } else foldEditor();
    }
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
  productList('stars',favorites,r=>[product(r,'stars'),favoriteButton(r,true)],'찜한 매물이 없어요.',favorites.map(r=>[r.url,r.title,r.posted_at,r.found_at,r.image,r.stock_available]));
  document.querySelectorAll('.source time').forEach(updateListingAge);
  el('status').textContent='확인 '+new Date().toLocaleTimeString();
}
async function run(fn) {
  try {if(fn) await fn(); await refresh();} catch(e){el('status').textContent=e.message;}
}
const favoriteLinkForm=el('favorite-link-form');
if(favoriteLinkForm) favoriteLinkForm.onsubmit=async event=>{
  event.preventDefault();
  const input=el('favorite-link-url'), feedback=el('favorite-link-status');
  const submit=favoriteLinkForm.querySelector('button[type="submit"]');
  if(submit.disabled) return;
  const url=input.value.trim();
  if(!url) return;
  submit.disabled=true;
  feedback.textContent='추가 중…';
  try {
    const result=await api('/favorite-link',{url},AbortSignal.timeout(15000));
    if(input.value.trim()===url) input.value='';
    feedback.textContent=result.added ? '찜 목록에 추가했어요.' : '이미 찜한 상품이에요.';
    await run();
  } catch(error) {
    feedback.textContent=error.status===400 ? '메루카리 또는 만다라케 상품 상세 링크를 입력해 주세요.' : '상품을 추가하지 못했어요. 다시 시도해 주세요.';
  } finally {submit.disabled=false;}
};
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
