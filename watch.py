import asyncio
import json
import os
import re
import unicodedata
from xml.etree import ElementTree as ET
from urllib.parse import urlsplit

import requests
from mercapi import Mercapi
from mercapi.requests import SearchRequestData as Search

def normalize(value):
    return ''.join(unicodedata.normalize('NFKC', value).casefold().split())

def nakano():
    response = requests.get('https://order.mandarake.co.jp/rss/?shop=1', timeout=25)
    response.raise_for_status()
    rows = []
    for item in ET.fromstring(response.content).iter():
        if item.tag.split('}')[-1] not in ('item', 'entry'):
            continue
        link = item.find('{*}link')
        if link is None:
            continue
        url = (link.get('href') or link.text or '').strip()
        title = item.findtext('{*}title')
        parsed = urlsplit(url)
        if title and parsed.scheme == 'https' and (parsed.hostname or '').endswith('.mandarake.co.jp'):
            rows.append([url, title])
    if not rows:
        raise ValueError('Empty Nakano feed')
    return rows

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
