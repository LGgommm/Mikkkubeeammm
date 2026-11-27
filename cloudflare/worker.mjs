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
async function deliver(db, device) {
  const id = await identity(db);
  const signer = await crypto.subtle.importKey('jwk',JSON.parse(id.jwk),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const claims = {aud:new URL(device.endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,sub:'https://lggommm.github.io/Mikkkubeeammm/'};
  const message = encode('{"typ":"JWT","alg":"ES256"}')+'.'+encode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signer,new TextEncoder().encode(message));
  const response = await fetch(device.endpoint,{method:'POST',redirect:'error',headers:{TTL:'1800',Urgency:'high',Authorization:'vapid t='+message+'.'+b64(sig)+', k='+id.public_key},body:new Uint8Array(0)});
  if(response.ok) await db.prepare('UPDATE push_devices SET pending=MAX(0,pending-?) WHERE owner=? AND endpoint=?').bind(device.pending,device.owner,device.endpoint).run();
  else if([404,410].includes(response.status)) await db.prepare('DELETE FROM push_devices WHERE owner=? AND endpoint=?').bind(device.owner,device.endpoint).run();
  return response.ok;
}
async function drain(db) {
  const devices = await db.prepare('SELECT * FROM push_devices WHERE pending>0 ORDER BY RANDOM() LIMIT 12').all();
  await Promise.allSettled(devices.results.map(device=>deliver(db,device)));
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
    if (path === '/collector/watches' && req.method === 'GET') await drain(env.DB);
    if (path === '/collector/watches' && req.method === 'GET')
      return reply((await env.DB.prepare('SELECT id,shop,keyword FROM watches WHERE active=1').all()).results);
    if (path === '/collector/results' && req.method === 'POST') {
      const {id,rows} = await req.json();
      if (!Array.isArray(rows)) return reply({},400);
      const insert = rows.map(([url,title]) => sql('INSERT OR IGNORE INTO matches(watch_id,url,title,visible) SELECT id,?,?,initialized FROM watches WHERE id=? AND active=1',url,title,id));
      await env.DB.batch([...insert,sql('UPDATE watches SET initialized=1 WHERE id=? AND active=1',id)]);
      await drain(env.DB);
      return reply({});
    }
    return reply({},404);
  }
  if (!/^[a-f0-9]{64}$/.test(key)) return reply({},401);
  const owner = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), b=>b.toString(16).padStart(2,'0')).join('');
  if(path==='/push/key') return reply({key:(await identity(env.DB)).public_key});
  if(path.startsWith('/push/') && req.method==='POST') {
    const {endpoint} = await req.json();
    if(!allowedEndpoint(endpoint)) return reply({},400);
    if(path==='/push/subscribe') {
      await sql('INSERT OR IGNORE INTO push_devices(endpoint,owner) VALUES(?,?)',endpoint,owner).run();
      return reply({});
    }
    if(path==='/push/test') {
      const device=await sql('SELECT * FROM push_devices WHERE endpoint=? AND owner=?',endpoint,owner).first();
      return device && await deliver(env.DB,{...device,pending:0}) ? reply({}) : reply({},502);
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
      sql('SELECT id,shop,keyword,active,initialized FROM watches WHERE owner=? ORDER BY id DESC',owner),
      sql('SELECT m.url,m.title,w.shop,w.keyword,m.found_at FROM matches m JOIN watches w ON w.id=m.watch_id WHERE w.owner=? AND m.visible=1 ORDER BY m.found_at DESC LIMIT 300',owner),
      sql('SELECT url,title FROM favorites WHERE owner=? ORDER BY saved_at DESC',owner)]);
    return reply({watches:w.results,hits:h.results,favorites:f.results});
  }
  if (req.method !== 'POST') return reply({},405);
  const b = await req.json();
  if (path === '/watch' && ['mercari','nakano'].includes(b.shop) && typeof b.keyword==='string' && b.keyword.trim() && b.keyword.trim().length<=80)
    await sql('INSERT INTO watches(owner,shop,keyword) VALUES(?,?,?) ON CONFLICT(owner,shop,keyword) DO UPDATE SET active=1',owner,b.shop,b.keyword.trim()).run();
  else if (path === '/toggle') await sql('UPDATE watches SET active=? WHERE id=? AND owner=?',b.active ? 1:0,b.id,owner).run();
  else if (path === '/delete') await sql('DELETE FROM watches WHERE owner=? AND id=?',owner,b.id).run();
  else if (path === '/favorite' && b.add) await sql('INSERT OR IGNORE INTO favorites(owner,url,title) SELECT ?,m.url,m.title FROM matches m JOIN watches w ON w.id=m.watch_id WHERE w.owner=? AND m.url=? AND m.visible=1 LIMIT 1',owner,owner,b.url).run();
  else if (path === '/favorite') await sql('DELETE FROM favorites WHERE owner=? AND url=?',owner,b.url).run();
  else return reply({},400);
  return reply({});
}};
