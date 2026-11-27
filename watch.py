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

repo = os.environ['GITHUB_REPOSITORY']
base = 'https://api.github.com/repos/' + repo
github = requests.Session()
github.headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
marker = '<!--market-v1:'

def pages(url, params=None):
    while url:
        response = github.get(url, params=params, timeout=30)
        response.raise_for_status()
        yield from response.json()
        url = response.links.get('next', {}).get('url')
        params = None

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
    issues = pages(base + '/issues', {'state':'open','per_page':100})
    client = Mercapi()
    failed = False
    feed = None
    for issue in issues:
        match = re.fullmatch(r'\[(메루카리|만다라케)\] (.{1,80})', issue['title'])
        if not match or issue['author_association'] not in ('OWNER','MEMBER','COLLABORATOR') or 'pull_request' in issue:
            continue
        shop, word = match.groups()
        try:
            if shop == '메루카리':
                result = await client.search(word, sort_by=Search.SortBy.SORT_CREATED_TIME, status=[Search.Status.STATUS_ON_SALE])
                rows = [['https://jp.mercari.com/item/' + x.id_, f'{x.name} ({x.price:,}円)'] for x in result.items if re.fullmatch(r'm\d+', x.id_)]
            else:
                if feed is None:
                    feed = nakano()
                rows = [r for r in feed if normalize(word) in normalize(r[1])]
            history = set()
            initialized = False
            for c in pages(issue['comments_url'], {'per_page':100}):
                if c['user']['login'] == 'github-actions[bot]' and c['body'].startswith(marker):
                    record = json.loads(c['body'].split('\n',1)[0][len(marker):-3])
                    history.update(record['ids'])
                    initialized = True
            fresh = dict((url,title) for url,title in rows if url not in history)
            if initialized and not fresh:
                continue
            record = {'ids':list(fresh), 'items':list(fresh.items()) if initialized else []}
            data = json.dumps(record, ensure_ascii=True).replace('<','\\u003c').replace('>','\\u003e')
            body = marker + data + '-->\n'
            body += ('새 매물 ' + str(len(fresh)) + '건\n' + '\n'.join(f'- <{url}>' for url in fresh)) if initialized else '키워드 등록 완료. 다음 수집부터 새 매물을 알려드려요.'
            github.post(issue['comments_url'], json={'body':body}, timeout=30).raise_for_status()
        except Exception as error:
            print(f"Issue #{issue['number']}: {type(error).__name__}: {error}", flush=True)
            failed = True
    if failed:
        raise SystemExit(1)

if __name__ == '__main__':
    asyncio.run(run())
