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
    if (path === '/collector/watches' && req.method === 'GET')
      return reply((await env.DB.prepare('SELECT id,shop,keyword FROM watches WHERE active=1').all()).results);
    if (path === '/collector/results' && req.method === 'POST') {
      const {id,rows} = await req.json();
      if (!Array.isArray(rows)) return reply({},400);
      const insert = rows.map(([url,title]) => sql('INSERT OR IGNORE INTO matches(watch_id,url,title,visible) SELECT id,?,?,initialized FROM watches WHERE id=? AND active=1',url,title,id));
      await env.DB.batch([...insert,sql('UPDATE watches SET initialized=1 WHERE id=? AND active=1',id)]);
      return reply({});
    }
    return reply({},404);
  }
  if (!/^[a-f0-9]{64}$/.test(key)) return reply({},401);
  const owner = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), b=>b.toString(16).padStart(2,'0')).join('');
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
