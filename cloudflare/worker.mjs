const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const encode = text => b64(new TextEncoder().encode(text));
async function identity(db) {
  const read = () => db.prepare('SELECT * FROM push_identity WHERE id=1').first();
  const existing = await read();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk',pair.privateKey);
  const raw = await crypto.subtle.exportKey('raw',pair.publicKey);
  await db.prepare('INSERT OR IGNORE INTO push_identity VALUES(1,?,?)').bind(JSON.stringify(jwk),b64(raw)).run();
  return read();
}
function allowedEndpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol==='https:' && !u.username && !u.password && !u.port && u.pathname.length>1 &&
      (u.hostname==='web.push.apple.com' || u.hostname.endsWith('.push.apple.com') || u.hostname==='fcm.googleapis.com' || u.hostname.endsWith('.push.services.mozilla.com'));
  } catch { return false; }
}
const utf8 = s => new TextEncoder().encode(s);
const decodeKey = s => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
function concat(...parts) {
  const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let pos=0;
  for(const p of parts){out.set(p,pos);pos+=p.length;}
  return out;
}
async function hkdf(secret,salt,info,length) {
  const k=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,length*8));
}
async function encryptPush(keys, payload) {
  const ua=decodeKey(keys.p256dh);
  const alg={name:'ECDH',namedCurve:'P-256'};
  const pair=await crypto.subtle.generateKey(alg,true,['deriveBits']);
  const as=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  const peer=await crypto.subtle.importKey('raw',ua,alg,false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256);
  const ikm=await hkdf(shared,decodeKey(keys.auth),concat(utf8('WebPush: info\0'),ua,as),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(ikm,salt,utf8('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(ikm,salt,utf8('Content-Encoding: nonce\0'),12);
  const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,concat(utf8(JSON.stringify(payload)),Uint8Array.of(2)));
  return concat(salt,Uint8Array.of(0,0,16,0,65),as,new Uint8Array(cipher));
}
async function listingNotice(row,testId) {
  const url=new URL(row.url);
  const match=row.title.match(/\s*\(([\d,]+)円\)$/);
  let title=match ? row.title.slice(0,match.index) : row.title;
  let price=match ? match[1]+'엔' : '';
  let image=row.image || '';
  const mercari=url.hostname==='jp.mercari.com' && url.pathname.match(/^\/item\/(m\d+)$/);
  const auction=url.hostname==='ekizo.mandarake.co.jp' && url.pathname==='/auction/item/itemInfoJa.html' && /^\d+$/.test(url.searchParams.get('index')||'');
  const catalogue=url.hostname==='order.mandarake.co.jp' && url.pathname==='/order/detailPage/item' && /^\d+$/.test(url.searchParams.get('itemCode')||'');
  if(mercari) image='https://static.mercdn.net/item/detail/orig/photos/'+mercari[1]+'_1.jpg';
  if(auction || catalogue) {
    try {
      const source=await fetch(url.href,{redirect:'error',signal:AbortSignal.timeout(6000),cf:{cacheTtl:180,cacheEverything:true}});
      if(source.ok) {
        const html=await source.text();
        const photo=html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)/i)
          || html.match(/(?:src|href)=["']((?:https:)?\/\/img\.mandarake\.co\.jp\/[^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)/i);
        if(photo) {
          const candidate=new URL(photo[1].replaceAll('&amp;','&'),url.href);
          if(candidate.protocol==='https:' && candidate.hostname.endsWith('.mandarake.co.jp') && candidate.href.length<1024) image=candidate.href;
        }
        const plain=html.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ');
        const yen=auction ? plain.match(/現在価格\s*([\d,]+)\s*円/) :
          html.match(/["']price["']\s*:\s*["']?([\d,]+)/i) || plain.match(/(?:販売価格|価格)\s*[:：]?\s*([\d,]+)\s*円/);
        if(yen) price=yen[1]+'엔';
      }
    } catch { /* Deliver the known listing even if the shop is temporarily unavailable. */ }
  }
  return {testId,title:(testId?'시험 알림 · ':'새 매물 · ')+row.keyword.slice(0,80),
    body:title.slice(0,230)+'\n'+(price || '가격 미표시'),image,url:url.href,tag:testId || row.keyword+'|'+url.href};
}

async function deliver(db, device, payload, checkKeys=null) {
  const id = await identity(db);
  const signer = await crypto.subtle.importKey('jwk',JSON.parse(id.jwk),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const claims = {aud:new URL(device.endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,sub:'https://lggommm.github.io/Mikkkubeeammm/'};
  const message = encode('{"typ":"JWT","alg":"ES256"}')+'.'+encode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signer,new TextEncoder().encode(message));
  const keys=checkKeys || await db.prepare('SELECT p256dh,auth FROM push_keys WHERE endpoint=?').bind(device.endpoint).first();
  if(!keys) return {accepted:false,stage:'subscription'};
  const body=await encryptPush(keys,payload);
  if(checkKeys) return {bytes:body.byteLength,signature:sig.byteLength};
  let response;
  try {response = await fetch(device.endpoint,{method:'POST',redirect:'manual',headers:{...(body ? {'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'} : {}),TTL:'1800',Urgency:'high',Authorization:'vapid t='+message+'.'+b64(sig)+', k='+id.public_key},body});} catch {return {accepted:false,stage:'network'};}
  if([404,410].includes(response.status)) await db.prepare('DELETE FROM push_devices WHERE owner=? AND endpoint=?').bind(device.owner,device.endpoint).run();
  const detail=response.ok ? {} : await response.json().catch(()=>({}));
  const reason=typeof detail?.reason==='string' && /^[A-Za-z]{1,60}$/.test(detail.reason) ? detail.reason : '';
  return {accepted:response.ok,providerStatus:response.status,reason};
}
// Compare marketplace posting time with the current watch session, including on push retries.
const freshMercari = stamp => `${stamp} BETWEEN MAX(unixepoch()-86400,(SELECT started_at FROM mercari_sessions WHERE watch_id=w.id)) AND unixepoch()`;
async function drain(db) {
  const claimed=await db.prepare('UPDATE listing_push SET retry_after=unixepoch()+120 WHERE id IN (SELECT id FROM listing_push WHERE retry_after<=unixepoch() ORDER BY retry_after,id LIMIT 8) RETURNING id,endpoint,watch_id,url').all();
  await Promise.allSettled(claimed.results.map(async job=>{
    const listing=await db.prepare(`SELECT d.owner,d.endpoint,w.keyword,m.title,m.url FROM push_devices d JOIN watches w ON w.owner=d.owner JOIN matches m ON m.watch_id=w.id LEFT JOIN listing_times t ON t.url=m.url WHERE d.endpoint=? AND w.id=? AND m.url=? AND (w.shop<>\'mercari\' OR (w.active=1 AND ${freshMercari('t.posted_at')}))`).bind(job.endpoint,job.watch_id,job.url).first();
    if(listing) {
      const result=await deliver(db,listing,await listingNotice(listing,null));
      if(!result.accepted) return;
    }
    await db.prepare('DELETE FROM listing_push WHERE id=?').bind(job.id).run();
  }));
}
async function drainRestocks(db) {
  const jobs=await db.prepare('UPDATE restock_push SET retry_after=unixepoch()+120 WHERE id IN (SELECT id FROM restock_push WHERE retry_after<=unixepoch() ORDER BY id LIMIT 6) RETURNING id,owner,endpoint,url').all();
  await Promise.allSettled(jobs.results.map(async job=>{
    const row=await db.prepare('SELECT f.title,f.url,c.image FROM favorites f LEFT JOIN nakano_catalogue c ON c.url=f.url JOIN favorite_stock s ON s.owner=f.owner AND s.url=f.url JOIN push_devices d ON d.owner=f.owner WHERE f.owner=? AND f.url=? AND d.endpoint=? AND s.available=1').bind(job.owner,job.url,job.endpoint).first();
    if(row) {
      const notice=await listingNotice({...row,keyword:'만다라케 나카노점'},null);
      notice.title='찜한 상품 재입고 · 만다라케 나카노점';
      notice.tag='restock|'+job.id;
      const result=await deliver(db,job,notice);
      if(!result.accepted) return;
    }
    await db.prepare('DELETE FROM restock_push WHERE id=?').bind(job.id).run();
  }));
}
const origin = 'https://lggommm.github.io';
function reply(data, status = 200) {
  return Response.json(data, {status, headers:{
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':'Authorization, Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    'Cache-Control':'no-store'
  }});
}
export default {async fetch(req, env) {
  if (req.method === 'OPTIONS') return reply({});
  const path = new URL(req.url).pathname;
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer /,'');
  const sql = (query,...params) => env.DB.prepare(query).bind(...params);
  if (path.startsWith('/collector/')) {
    if (!env.COLLECTOR_TOKEN || key !== env.COLLECTOR_TOKEN) return reply({},403);
    if (path==='/collector/push-check') {
      try {
        const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
        const keys={p256dh:b64(await crypto.subtle.exportKey('raw',pair.publicKey)),auth:b64(crypto.getRandomValues(new Uint8Array(16)))};
        const check=await deliver(env.DB,{endpoint:'https://web.push.apple.com/test'},{title:'서버 점검',body:'암호화 확인'},keys);
        for(const mode of ['error','manual']) {
          try {check[mode]=(await fetch('https://web.push.apple.com/',{method:'HEAD',redirect:mode})).status;}
          catch(e) {check[mode]=String(e.message).slice(0,100);}
        }
        return reply(check);
      } catch(e) {return reply({error:e.name,description:String(e.message).slice(0,180)});}
    }
    if(path==='/collector/restocks' && req.method==='GET') {
      await drainRestocks(env.DB);
      return reply((await sql('SELECT url FROM favorite_stock GROUP BY url ORDER BY MIN(checked_at),url LIMIT 12').all()).results);
    }
    if(path==='/collector/restocks' && req.method==='POST') {
      const {observations}=await req.json();
      if(!Array.isArray(observations) || observations.length>12) return reply({},400);
      const updates=[];
      for(const {url,available,at} of observations) {
        if(typeof url!=='string' || !Number.isSafeInteger(at) || at>Date.now()+60000 ||
           (available!==null && typeof available!=='boolean')) return reply({},400);
        updates.push(sql('UPDATE favorite_stock SET available=COALESCE(?,available),checked_at=? WHERE url=? AND checked_at<?',available===null?null:Number(available),at,url,at));
      }
      if(updates.length) await env.DB.batch(updates);
      await drainRestocks(env.DB);
      return reply({});
    }
    if (path === '/collector/watches' && req.method === 'GET') await drain(env.DB);
    if (path === '/collector/watches' && req.method === 'GET')
      return reply((await env.DB.prepare('SELECT w.id,w.shop,w.keyword,p.min_yen,p.max_yen,k.min_krw,k.max_krw FROM watches w LEFT JOIN keyword_prices p USING(owner,keyword) LEFT JOIN keyword_prices_krw k USING(owner,keyword) WHERE active=1').all()).results);
    if (path === '/collector/results' && req.method === 'POST') {
      const {id,rows,posted={},catalogue={}} = await req.json();
      if (!Array.isArray(rows)) return reply({},400);
      const insert = rows.map(([url,title]) => sql(`INSERT OR IGNORE INTO matches(watch_id,url,title,visible)
        SELECT w.id,?,?,CASE WHEN w.shop='mercari' THEN 1 WHEN w.initialized=0 OR ?=1 THEN 2 ELSE 1 END FROM watches w
        WHERE w.id=? AND w.active=1 AND (w.shop<>'mercari' OR ${freshMercari('?')})`,
        url,title,catalogue[url]?.available===false?1:0,id,Number.isSafeInteger(posted[url]) ? posted[url] : null));
      const cards=rows.flatMap(([url])=>{
        const card=catalogue[url];
        if(typeof card?.available!=='boolean' || !/^https:\/\/order\.mandarake\.co\.jp\/order\/detailPage\/item\?itemCode=\d+$/.test(url)) return [];
        const image=typeof card.image==='string' && card.image.startsWith('https://img.mandarake.co.jp/') ? card.image : '';
        return [sql('INSERT INTO nakano_catalogue(url,available,image) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET available=excluded.available,image=excluded.image',url,Number(card.available),image)];
      });
      const times=rows.filter(([url])=>Number.isSafeInteger(posted[url]) && posted[url]>0 && posted[url]<=Date.now()/1000)
        .map(([url])=>sql('INSERT OR IGNORE INTO listing_times(url,posted_at) VALUES(?,?)',url,posted[url]));
      await env.DB.batch([...cards,...insert,...times,sql('UPDATE watches SET initialized=1 WHERE id=? AND active=1',id)]);
      await drain(env.DB);
      return reply({});
    }
    return reply({},404);
  }
  if (!/^[a-f0-9]{64}$/.test(key)) return reply({},401);
  const owner = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), b=>b.toString(16).padStart(2,'0')).join('');
  if(path==='/push/key') return reply({key:(await identity(env.DB)).public_key});
  if(path.startsWith('/push/') && req.method==='POST') {
    const {endpoint,keys,testId} = await req.json();
    if(!allowedEndpoint(endpoint)) return reply({},400);
    if(path==='/push/subscribe') {
      await sql('INSERT OR IGNORE INTO push_devices(endpoint,owner) VALUES(?,?)',endpoint,owner).run();
      if(keys) {
        if(!/^[\w-]{87}$/.test(keys.p256dh)||! /^[\w-]{22}$/.test(keys.auth)) return reply({},400);
        const device=await sql('SELECT owner FROM push_devices WHERE endpoint=?',endpoint).first();
        if(device.owner!==owner) return reply({},409);
        await sql('INSERT OR REPLACE INTO push_keys VALUES(?,?,?)',endpoint,keys.p256dh,keys.auth).run();
      }
      return reply({});
    }
    if(path==='/push/test') {
      const device=await sql('SELECT * FROM push_devices WHERE endpoint=? AND owner=?',endpoint,owner).first();
      if(!device) return reply({accepted:false,providerStatus:410});
      try {
        const row=await sql(`SELECT w.keyword,m.title,m.url FROM matches m JOIN watches w ON w.id=m.watch_id LEFT JOIN listing_times t ON t.url=m.url WHERE w.owner=? AND (w.shop<>'mercari' OR (w.active=1 AND m.visible=1 AND ${freshMercari('t.posted_at')})) ORDER BY RANDOM() LIMIT 1`,owner).first();
        if(!row) return reply({accepted:false,stage:'empty'});
        const notice=await listingNotice(row,typeof testId==='string'?testId.slice(0,64):'test');
        return reply(await deliver(env.DB,device,notice));
      } catch(e) {return reply({accepted:false,stage:'prepare',error:e.name});}
    }
    return reply({},404);
  }
  if (path === '/auction-card' && req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!/^\d{1,12}$/.test(id || '')) return reply({},400);
    const source = await fetch('https://ekizo.mandarake.co.jp/auction/item/itemInfoJa.html?index=' + id,
      {cf:{cacheTtl:180,cacheEverything:true}});
    if (!source.ok) return reply({},502);
    const html = await source.text();
    const photo = html.match(/(?:href|src)=["']((?:https:)?\/\/img\.mandarake\.co\.jp\/[^"']+\.(?:jpg|jpeg|webp)(?:\?[^"']*)?)["']/i);
    const price = html.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').match(/現在価格\s*([\d,]+)\s*円/);
    return reply({image:photo ? new URL(photo[1],source.url).href : null,price:price ? price[1]+'円' : null});
  }
  if (path === '/state' && req.method === 'GET') {
    const [w,h,f] = await env.DB.batch([
      sql('SELECT w.id,w.shop,w.keyword,w.active,w.initialized,p.min_yen,p.max_yen,k.min_krw,k.max_krw FROM watches w LEFT JOIN keyword_prices p USING(owner,keyword) LEFT JOIN keyword_prices_krw k USING(owner,keyword) WHERE w.owner=? ORDER BY w.id DESC',owner),
      sql('SELECT m.url,m.title,w.shop,w.keyword,m.found_at,t.posted_at,c.image,c.available AS catalogue_available FROM matches m JOIN watches w ON w.id=m.watch_id LEFT JOIN listing_times t ON t.url=m.url LEFT JOIN nakano_catalogue c ON c.url=m.url WHERE w.owner=? AND m.visible>0 ORDER BY m.found_at DESC LIMIT 300',owner),
      sql('SELECT f.url,f.title,t.posted_at,s.available AS stock_available,c.image,(SELECT MIN(m.found_at) FROM watches w JOIN matches m ON m.watch_id=w.id WHERE w.owner=f.owner AND m.url=f.url) AS found_at FROM favorites f LEFT JOIN nakano_catalogue c ON c.url=f.url LEFT JOIN favorite_stock s ON s.owner=f.owner AND s.url=f.url LEFT JOIN listing_times t ON t.url=f.url WHERE f.owner=? ORDER BY f.saved_at DESC',owner)]);
    return reply({watches:w.results,hits:h.results,favorites:f.results});
  }
  if (req.method !== 'POST') return reply({},405);
  const b = await req.json();
  if (path === '/keyword-price' || path === '/keyword-shops') {
    if(typeof b.keyword!=='string' || !await sql('SELECT 1 FROM watches WHERE owner=? AND keyword=?',owner,b.keyword).first()) return reply({},404);
    if(path==='/keyword-price') {
      const valid=n=>n===null || (Number.isSafeInteger(n) && n>=0);
      if(!valid(b.min) || !valid(b.max) || (b.min!==null && b.max!==null && b.min>b.max)) return reply({},400);
      if(b.currency==='KRW') {
        if(b.min===null || b.max===null || b.max>1000000) return reply({},400);
        await env.DB.batch([sql('INSERT INTO keyword_prices_krw(owner,keyword,min_krw,max_krw) VALUES(?,?,?,?) ON CONFLICT(owner,keyword) DO UPDATE SET min_krw=excluded.min_krw,max_krw=excluded.max_krw',owner,b.keyword,b.min,b.max),sql('DELETE FROM keyword_prices WHERE owner=? AND keyword=?',owner,b.keyword)]);
      } else {
        await env.DB.batch([sql('INSERT INTO keyword_prices(owner,keyword,min_yen,max_yen) VALUES(?,?,?,?) ON CONFLICT(owner,keyword) DO UPDATE SET min_yen=excluded.min_yen,max_yen=excluded.max_yen',owner,b.keyword,b.min,b.max),sql('DELETE FROM keyword_prices_krw WHERE owner=? AND keyword=?',owner,b.keyword)]);
      }
    } else {
      if(!Array.isArray(b.shops) || !b.shops.length || !b.shops.every(s=>['mercari','nakano'].includes(s))) return reply({},400);
      const chosen=new Set(b.shops);
      const changes=Array.from(chosen,s=>sql('INSERT OR IGNORE INTO watches(owner,shop,keyword,active) SELECT ?,?,?,MAX(active) FROM watches WHERE owner=? AND keyword=? HAVING COUNT(*)>0',owner,s,b.keyword,owner,b.keyword));
      for(const s of ['mercari','nakano']) if(!chosen.has(s)) changes.push(sql('DELETE FROM watches WHERE owner=? AND keyword=? AND shop=?',owner,b.keyword,s));
      await env.DB.batch(changes);
    }
    return reply({});
  }
  if (path === '/watch' && ['mercari','nakano'].includes(b.shop) && typeof b.keyword==='string' && b.keyword.trim() && b.keyword.trim().length<=80)
    await sql('INSERT INTO watches(owner,shop,keyword) VALUES(?,?,?) ON CONFLICT(owner,shop,keyword) DO UPDATE SET active=1',owner,b.shop,b.keyword.trim()).run();
  else if (path === '/toggle') await sql('UPDATE watches SET active=? WHERE id=? AND owner=?',b.active ? 1:0,b.id,owner).run();
  else if (path === '/delete') await sql('DELETE FROM watches WHERE owner=? AND id=?',owner,b.id).run();
  else if (path === '/favorite' && b.add) await sql('INSERT OR IGNORE INTO favorites(owner,url,title) SELECT ?,m.url,m.title FROM matches m JOIN watches w ON w.id=m.watch_id WHERE w.owner=? AND m.url=? AND m.visible>0 LIMIT 1',owner,owner,b.url).run();
  else if (path === '/favorite') await sql('DELETE FROM favorites WHERE owner=? AND url=?',owner,b.url).run();
  else return reply({},400);
  return reply({});
}};
