import asyncio
import json
import os
import re
import unicodedata
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

def nakano():
    response = requests.get(NAKANO_LIST, headers={'User-Agent': 'MarketAlerts/1.0'}, timeout=25)
    response.raise_for_status()
    if urlsplit(response.url).path != '/order/listPage/list':
        raise ValueError('Nakano listing redirected away from the catalogue')
    parser = ListingParser()
    parser.feed(response.content.decode('utf-8', errors='replace'))
    if not parser.rows:
        raise ValueError('No product links in Nakano listing')
    return list(parser.rows.items())

async def run():
    base = os.environ['MARKET_API'].rstrip('/')
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + os.environ['COLLECTOR_TOKEN']
    response = session.get(base + '/collector/watches', timeout=30)
    response.raise_for_status()
    client = Mercapi()
    failed = False
    feed = None
    for watch in response.json():
        shop, word = watch['shop'], watch['keyword']
        try:
            if shop == 'mercari':
                result = await client.search(word, sort_by=Search.SortBy.SORT_CREATED_TIME, status=[Search.Status.STATUS_ON_SALE])
                rows = [['https://jp.mercari.com/item/' + x.id_, f'{x.name} ({x.price:,}円)'] for x in result.items if re.fullmatch(r'm\d+', x.id_)]
            else:
                if feed is None:
                    feed = nakano()
                rows = [r for r in feed if normalize(word) in normalize(r[1])]
            session.post(base + '/collector/results', json={'id':watch['id'], 'rows':rows}, timeout=30).raise_for_status()
        except Exception as error:
            print(f"Watch {watch['id']}: {type(error).__name__}", flush=True)
            failed = True
    if failed:
        raise SystemExit(1)

if __name__ == '__main__':
    asyncio.run(run())
