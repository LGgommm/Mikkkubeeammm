import asyncio
import json
import os
import re
import unicodedata
from decimal import Decimal, ROUND_HALF_UP
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup
from urllib.parse import parse_qs, urljoin, urlsplit

import requests
from mercapi import Mercapi
from mercapi.requests import SearchRequestData as Search

def normalize(value):
    return ''.join(unicodedata.normalize('NFKC', value).casefold().split())

SHOP = 'https://www.mandarake.co.jp/dir/nkn/'
ORDER = 'https://order.mandarake.co.jp/order/'
DETAIL = ORDER + 'detailPage/item?itemCode='
AUCTION = 'https://ekizo.mandarake.co.jp/auction/item/itemInfoJa.html?index='

def product_link(href, base):
    url = urlsplit(urljoin(base, href))
    for prefix, key in ((DETAIL,'itemCode'), (AUCTION,'index')):
        expected = urlsplit(prefix)
        if (url.hostname, url.path) == (expected.hostname, expected.path):
            code = parse_qs(url.query).get(key, [''])[0]
            if re.fullmatch(r'[0-9]+', code):
                return prefix + code
    return None

def page(url, **kwargs):
    result = requests.get(url, headers={'User-Agent':'MarketAlerts/1.0'}, timeout=12, **kwargs)
    result.raise_for_status()
    return result

def catalogue(word):
    result = page(ORDER+'listPage/serchKeyWord', params={'shop':1,'soldOut':0,'keyword':word,'categoryCode':'00','lang':'ja'})
    final = urlsplit(result.url)
    if final.hostname != urlsplit(ORDER).hostname or not final.path.startswith('/order/listPage/'):
        raise ValueError('Catalogue unavailable')
    soup = BeautifulSoup(result.content, 'html.parser', from_encoding='utf-8')
    rows = {}
    for a in soup.select('a[href]'):
        url = product_link(a['href'],result.url)
        if not url or not url.startswith(DETAIL):
            continue
        text = a.get_text(' ',strip=True) or a.get('title') or (a.img.get('alt','') if a.img else '')
        if text:
            rows[url] = text
    return rows

def arrivals(stock,terms=()):
    # The shop's own public widget runs on its Nakano pages and returns zaiko per item.
    from playwright.sync_api import sync_playwright, Error as BrowserError
    binary = os.environ.get('MARKET_CHROME') or shutil.which('google-chrome') or shutil.which('chromium')
    endpoint = 'https://tools.mandarake.co.jp/tools/newArrivalItems/'
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=binary)
            tab = browser.new_page()
            tab.route('**/*', lambda route: route.continue_() if route.request.is_navigation_request() or
                      (route.request.url == endpoint or route.request.url.startswith(ORDER+'json/itemlist?')) else route.abort())
            tab.goto(SHOP,wait_until='domcontentloaded',timeout=25000)
            if urlsplit(tab.url).hostname != 'www.mandarake.co.jp':
                raise ValueError('Nakano widget page unavailable')
            items = tab.evaluate("""async url=>{
              try {const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({shop:1,adult:false,stock_only:false,count:100}),signal:AbortSignal.timeout(15000)});
              if(!response.ok) throw Error('Nakano widget '+response.status);
              const payload=await response.json();
              if(payload.status!=='success' || !Array.isArray(payload.data)) throw Error('Invalid Nakano widget response');
              return payload.data;} catch {return [];}
            }""",endpoint)
            for term in dict.fromkeys(terms):
                found=tab.evaluate("""term=>new Promise(resolve=>{
                  const callback='json_callback';
                  const script=document.createElement('script');
                  function finish(items) {
                    clearTimeout(timer);script.remove();delete window[callback];resolve(items);
                  }
                  const timer=setTimeout(()=>finish([]),15000);
                  window[callback]=r=>finish(Array.isArray(r.items)?r.items:[]);
                  script.onerror=()=>finish([]);
                  script.src='https://order.mandarake.co.jp/order/json/itemlist?'+new URLSearchParams({
                    callback,limit:20,offset:0,lang:'ja',keyword:term,category:'00',shop_code:1,urikire_ari:1,adult_condition:0
                  });
                  document.head.append(script);
                })""",term)
                for item in found:
                    if str(item.get('shop_code','')).lstrip('0')!='1' or str(item.get('adult',0))=='1':
                        continue
                    items.append({'shop':1,'item_code':item.get('idx'),'title':item.get('title'),'price':item.get('price'),
                                  'thumbnail':urljoin('https://img.mandarake.co.jp/',item.get('thumnail') or ''),
                                  'zaiko':item.get('zaiko')})
    except BrowserError as error:
        raise ValueError('Nakano widget unavailable') from error
    rows = {}
    for item in items:
        code = str(item.get('item_code',''))
        raw_quantity=item.get('zaiko')
        quantity=str(int(raw_quantity)) if isinstance(raw_quantity,bool) else str(raw_quantity)
        if str(item.get('shop'))!='1' or not code.isdigit() or not quantity.isdigit():
            continue
        url = DETAIL+code
        stock[url] = {'available':int(quantity)>0,'image':item.get('thumbnail') or ''}
        if item.get('title'):
            price = str(item.get('price','')).replace(',','')
            rows[url] = item['title'] + (f' ({int(price):,}円)' if price.isdigit() else '')
    return rows

def article_items(article):
    try:
        result = page(article)
    except requests.RequestException:
        return {}
    soup = BeautifulSoup(result.content, 'html.parser', from_encoding='utf-8')
    body = soup.select_one('[itemprop="articleBody"]')
    rows = {}
    if not body:
        return rows
    for a in body.select('a[href]'):
        url = product_link(a['href'],article)
        if not url:
            continue
        name = a.get_text(' ',strip=True)
        if not name or name.startswith('http') or name in ('こちら','通販はこちら'):
            block = a.find_parent('p')
            parts = list(block.stripped_strings) if block else []
            name = next((t for t in reversed(parts) if not t.startswith(('http','＜＜')) and t != name), '')
        if not name:
            title = soup.select_one('h1')
            name = title.get_text(' ',strip=True) if title else ''
        if name:
            rows[url] = name
    return rows

def nakano(stock_feed=None,terms=()):
    rows = {}
    try:
        rows.update(arrivals(stock_feed if stock_feed is not None else {},terms))
    except (requests.RequestException,ValueError,KeyError):
        pass
    try:
        soup = BeautifulSoup(page(SHOP).content,'html.parser',from_encoding='utf-8')
        articles = dict.fromkeys(urljoin(SHOP,a['href']) for a in soup.select('.post_block a[href]'))
        urls = [u for u in articles if re.fullmatch(r'https://(?:www\.)?mandarake\.co\.jp/dir/(?:cos/nkn|nkn)/[^?#]+\.html',u)]
        with ThreadPoolExecutor(max_workers=3) as pool:
            for items in pool.map(article_items,urls[:12]):
                rows.update(items)
    except requests.RequestException:
        if not rows: raise
    return list(rows.items())

def stock_status(html, url):
    soup = BeautifulSoup(html,'html.parser',from_encoding='utf-8')
    states = set()
    def observe(value):
        state = str(value).rstrip('/').rsplit('/',1)[-1]
        if state in ('InStock','OutOfStock','SoldOut'):
            states.add(state=='InStock')
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.get_text())
        except ValueError:
            continue
        nodes = data if isinstance(data,list) else [data]
        for node in nodes:
            if not isinstance(node,dict): continue
            nodes.extend(node.get('@graph',[]) if isinstance(node.get('@graph'),list) else [])
            if node.get('@type')!='Product': continue
            offers = node.get('offers',[])
            for offer in offers if isinstance(offers,list) else [offers]:
                if not isinstance(offer,dict): continue
                target = offer.get('url') or node.get('url')
                if target and product_link(str(target),url)!=url: continue
                if not target and str(node.get('sku',''))!=url.split('=')[-1] and len(nodes)>1: continue
                observe(offer.get('availability'))
    for tag in soup.select('[itemprop="availability"]'):
        product = tag.find_parent(attrs={'itemtype':re.compile(r'/Product$')})
        if product and len(soup.select('[itemtype$="/Product"]'))==1:
            observe(tag.get('href') or tag.get('content') or tag.get_text(strip=True))
    for tag in soup.select('meta[property="product:availability"],meta[property="og:availability"]'):
        status=tag.get('content','').strip().casefold()
        if status in ('in stock','out of stock','sold out'):
            states.add(status=='in stock')
    return states.pop() if len(states)==1 else None

def inspect_stock(row, stock_feed):
    url = row['url']
    observation = {'url':url,'available':None,'at':time.time_ns()//1_000_000}
    if not re.fullmatch(re.escape(DETAIL)+r'[0-9]+',url):
        return observation
    if url in stock_feed:
        observation['available']=stock_feed[url]['available']
        return observation
    try:
        response = page(url)
        if product_link(response.url, url)==url:
            observation['available'] = stock_status(response.content,url)
    except requests.RequestException:
        pass
    return observation

def check_favorites(session,base,stock_feed,rows):
    if not rows: return
    with ThreadPoolExecutor(max_workers=3) as pool:
        observations=list(pool.map(lambda row: inspect_stock(row,stock_feed),rows))
    if observations:
        session.post(base+'/collector/restocks',json={'observations':observations},timeout=30).raise_for_status()

async def run():
    base = os.environ['MARKET_API'].rstrip('/')
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + os.environ['COLLECTOR_TOKEN']
    response = session.get(base + '/collector/watches', timeout=30)
    response.raise_for_status()
    client = Mercapi()
    failed = False
    watches=response.json()
    favorites=session.get(base+'/collector/restocks',timeout=30)
    favorites.raise_for_status()
    favorites=favorites.json()
    terms=[w['keyword'] for w in watches if w['shop']=='nakano']
    # A saved item can leave the newest page. Search its title and compare the exact item code.
    terms.extend(re.sub(r' \([\d,]+円\)$','',f['title'])[:90] for f in favorites if f.get('title'))
    stock_feed={}
    searches={}
    feed=None
    auction_prices = {}
    won_per_yen = None
    for watch in watches:
        shop, word = watch['shop'], watch['keyword']
        try:
            posted = {}
            if shop == 'mercari':
                result = await client.search(word, sort_by=Search.SortBy.SORT_CREATED_TIME, status=[Search.Status.STATUS_ON_SALE])
                rows = [['https://jp.mercari.com/item/' + x.id_, f'{x.name} ({x.price:,}円)'] for x in result.items if re.fullmatch(r'm\d+', x.id_)]
                posted = {'https://jp.mercari.com/item/' + x.id_: int(x.created.timestamp()) for x in result.items if x.created}
            else:
                if feed is None:
                    try:
                        feed = await asyncio.to_thread(nakano,stock_feed,terms)
                    except requests.RequestException:
                        feed = []
                if word not in searches:
                    searches[word]={}
                    if not stock_feed:
                        try:
                            searches[word] = catalogue(word)
                        except (requests.RequestException,ValueError):
                            pass
                combined = dict(feed)
                combined.update(searches[word])
                rows = [(url,title) for url,title in combined.items() if all(normalize(term) in normalize(title) for term in word.split())]
            low, high = watch.get('min_yen'), watch.get('max_yen')
            krw = watch.get('max_krw') is not None
            if krw:
                low, high = watch['min_krw'], watch['max_krw']
                if won_per_yen is None:
                    quote = requests.get('https://api.frankfurter.dev/v1/latest', params={'base': 'JPY', 'symbols': 'KRW'}, timeout=15)
                    quote.raise_for_status()
                    won_per_yen = Decimal(str(quote.json()['rates']['KRW']))
                    if not won_per_yen.is_finite() or won_per_yen <= 0:
                        won_per_yen = None
                        raise ValueError('Invalid JPY/KRW exchange rate')
            if low is not None or high is not None:
                filtered = []
                for url, title in rows:
                    price_match = re.search(r'([\d,]+)\s*円\)?$', title)
                    amount = int(price_match[1].replace(',', '')) if price_match else None
                    if amount is None and url.startswith('https://ekizo.mandarake.co.jp/auction/item/itemInfoJa.html?index='):
                        if url not in auction_prices:
                            card = session.get(base + '/auction-card', params={'id': url.rsplit('=', 1)[1]}, timeout=25)
                            card.raise_for_status()
                            price = re.fullmatch(r'([\d,]+)円', card.json().get('price') or '')
                            auction_prices[url] = int(price[1].replace(',', '')) if price else None
                        amount = auction_prices[url]
                    if krw and amount is not None:
                        amount = (amount * won_per_yen).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
                    if amount is not None and (low is None or amount >= low) and (high is None or amount <= high):
                        filtered.append([url, title])
                rows = filtered
            metadata = {url:stock_feed[url] for url,_ in rows if stock_feed and url in stock_feed} if shop=='nakano' else {}
            session.post(base + '/collector/results', json={'id':watch['id'], 'rows':rows, 'posted':posted,'catalogue':metadata}, timeout=30).raise_for_status()
        except Exception as error:
            print(f"Watch {watch['id']}: {type(error).__name__}", flush=True)
            failed = True
    if feed is None and favorites:
        try:
            await asyncio.to_thread(arrivals,stock_feed,terms)
        except (requests.RequestException,ValueError,KeyError):
            pass
    await asyncio.to_thread(check_favorites,session,base,stock_feed,favorites)
    if failed:
        raise SystemExit(1)

if __name__ == '__main__':
    asyncio.run(run())
