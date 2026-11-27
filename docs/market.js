const repo = 'LGgommm/Mikkkubeeammm';
const web = 'https://github.com/' + repo;
const el = id => document.getElementById(id);
const favorites = new Map(JSON.parse(localStorage.getItem('market-stars') || '[]'));
let hits = [];
function link(text, url) {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = url;
  return a;
}
function render(id, rows, empty) {
  const nodes = rows.map(([url, title]) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = favorites.has(url) ? '찜 해제' : '찜';
    button.onclick = () => {
      if (favorites.has(url)) favorites.delete(url);
      else favorites.set(url, title);
      localStorage.setItem('market-stars', JSON.stringify([...favorites]));
      draw();
    };
    li.append(link(title, url), ' ', button);
    return li;
  });
  el(id).replaceChildren(...(nodes.length ? nodes : [empty]));
}
function draw() {
  render('hits', hits, '새로 발견한 매물이 없어요.');
  render('stars', [...favorites], '찜한 상품이 없어요.');
}
el('form').onsubmit = event => {
  event.preventDefault();
  const word = el('word').value.trim();
  if (word) location.href = web + '/issues/new?' + new URLSearchParams({title:'[' + el('shop').value + '] ' + word, body:'이 키워드의 새 매물 알림을 받습니다.'});
};
async function read(path) {
  let url = 'https://api.github.com/repos/' + repo + path;
  const rows = [];
  while (url) {
    const response = await fetch(url);
    if (!response.ok) throw Error('GitHub 목록을 불러오지 못했어요 (' + response.status + ').');
    rows.push(...await response.json());
    url = (response.headers.get('Link') || '').match(/<([^>]+)>; rel="next"/)?.[1];
  }
  return rows;
}
async function refresh() {
  el('reload').disabled = true;
  try {
    const [issues, comments] = await Promise.all([read('/issues?state=all&per_page=100'), read('/issues/comments?per_page=100&sort=created&direction=desc')]);
    const tracked = new Map(issues.filter(i => !i.pull_request && /^\[(메루카리|만다라케)\] /.test(i.title) && ['OWNER','MEMBER','COLLABORATOR'].includes(i.author_association)).map(i => [i.url,i]));
    el('watches').replaceChildren(...[...tracked.values()].filter(i => i.state === 'open').map(i => {
      const li = document.createElement('li');
      li.append(link(i.title, i.html_url));
      return li;
    }));
    const found = new Map();
    for (const c of comments) {
      const issue = tracked.get(c.issue_url);
      if (!issue || c.user.login !== 'github-actions[bot]' || !c.body.startsWith('<!--market-v1:')) continue;
      const record = JSON.parse(c.body.split('\n')[0].slice('<!--market-v1:'.length,-3));
      for (const [url,title] of record.items) if (!found.has(url)) found.set(url, issue.title + ' · ' + title);
    }
    hits = [...found];
    draw();
    el('status').textContent = '목록 확인 ' + new Date().toLocaleTimeString();
  } catch (e) { el('status').textContent = e.message; }
  finally { el('reload').disabled = false; }
}
draw();
el('reload').onclick = refresh;
refresh();
setInterval(() => { if (!document.hidden && !el('reload').disabled) refresh(); }, 300000);
