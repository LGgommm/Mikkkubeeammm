import asyncio
import json
import os
import re
import unicodedata
from decimal import Decimal, ROUND_HALF_UP
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlsplit

import requests
from mercapi import Mercapi
from mercapi.requests import SearchRequestData as Search

def normalize(value):
    return ''.join(unicodedata.normalize('NFKC', value).casefold().split())

NAKANO_LIST = 'https://order.mandarake.co.jp/order/listPage/list?shop=1&soldOut=1'

class ListingParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = {}
        self.url = None
        self.parts = []
        self.alt = ''

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a':
            self.url = None
            url = urlsplit(urljoin(NAKANO_LIST, attrs.get('href') or ''))
            item = parse_qs(url.query).get('itemCode', [''])[0]
            if url.hostname == 'order.mandarake.co.jp' and url.path == '/order/detailPage/item' and item.isdigit():
                self.url = 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=' + item
                self.parts = []
                self.alt = attrs.get('title') or ''
        elif self.url and tag == 'img':
            self.alt = attrs.get('alt') or self.alt

    def handle_data(self, data):
        if self.url:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self.url:
            title = ' '.join(' '.join(self.parts).split()) or self.alt.strip()
            if title:
                self.rows[self.url] = title
            self.url = None

def catalogue():
    response = requests.get(NAKANO_LIST, headers={'User-Agent': 'MarketAlerts/1.0'}, timeout=25)
    response.raise_for_status()
    if urlsplit(response.url).path != '/order/listPage/list':
        raise ValueError('Nakano listing redirected to ' + urlsplit(response.url).netloc + urlsplit(response.url).path)
    parser = ListingParser()
    parser.feed(response.content.decode('utf-8', errors='replace'))
    if not parser.rows:
        raise ValueError('No product links in Nakano listing')
    return list(parser.rows.items())

class Anchors(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.href = None
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.href = dict(attrs).get('href')
            self.parts = []
        elif tag == 'img' and self.href:
            self.parts.append(dict(attrs).get('alt') or '')

    def handle_data(self, data):
        if self.href:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self.href:
            self.links.append((self.href, ' '.join(self.parts)))
            self.href = None

def page_links(session, url):
    response = session.get(url, timeout=20)
    response.raise_for_status()
    parser = Anchors()
    parser.feed(response.content.decode('utf-8'))
    return [(urljoin(response.url, href), title) for href, title in parser.links]

def nakano():
    try:
        return catalogue()
    except (ValueError, requests.RequestException):
        pass

    rows = {}
    with requests.Session() as session:
        session.headers['User-Agent'] = 'MarketAlerts/1.0'
        topics = page_links(session, 'https://www.mandarake.co.jp/dir/nkn/')
        for article, description in dict(topics).items():
            if not re.fullmatch(r'https://www\.mandarake\.co\.jp/dir/(?:cos/nkn|nkn)/[^?#]+\.html', article):
                continue
            name = re.search(r'「([^」]+)」を出品', description)
            if not name:
                continue
            for url, _ in page_links(session, article):
                if re.fullmatch(r'https://ekizo\.mandarake\.co\.jp/auction/item/itemInfoJa\.html\?index=\d+', url):
                    rows[url] = name.group(1) + ' [中野店 オークション]'
                    break
    if not rows:
        raise ValueError('No linked Nakano products in shop announcements')
    return list(rows.items())

async def run():
    base = os.environ['MARKET_API'].rstrip('/')
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + os.environ['COLLECTOR_TOKEN']
    response = session.get(base + '/collector/watches', timeout=30)
    response.raise_for_status()
    client = Mercapi()
    failed = False
    feed = None
    auction_prices = {}
    won_per_yen = None
    for watch in response.json():
        shop, word = watch['shop'], watch['keyword']
        try:
            posted = {}
            if shop == 'mercari':
                result = await client.search(word, sort_by=Search.SortBy.SORT_CREATED_TIME, status=[Search.Status.STATUS_ON_SALE])
                rows = [['https://jp.mercari.com/item/' + x.id_, f'{x.name} ({x.price:,}円)'] for x in result.items if re.fullmatch(r'm\d+', x.id_)]
                posted = {'https://jp.mercari.com/item/' + x.id_: int(x.created.timestamp()) for x in result.items if x.created}
            else:
                if feed is None:
                    feed = nakano()
                rows = [r for r in feed if normalize(word) in normalize(r[1])]
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
            session.post(base + '/collector/results', json={'id':watch['id'], 'rows':rows, 'posted':posted}, timeout=30).raise_for_status()
        except Exception as error:
            print(f"Watch {watch['id']}: {type(error).__name__}", flush=True)
            failed = True
    if failed:
        raise SystemExit(1)

if __name__ == '__main__':
    asyncio.run(run())
