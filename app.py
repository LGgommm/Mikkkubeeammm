import hmac
import json
import os
import sqlite3
import threading
import time
import unicodedata
from contextlib import contextmanager
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

import requests
from flask import Flask, abort, jsonify, request

app = Flask(__name__, static_url_path="", static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 16384
FEED = "https://order.mandarake.co.jp/rss/?shop=1"
DB = os.getenv("DATABASE", "monitor.sqlite")
KEY = os.environ["ADMIN_KEY"]

@contextmanager
def database():
    conn = sqlite3.connect(DB, timeout=20)
    try:
        with conn:
            yield conn
    finally:
        conn.close()

def init():
    with database() as db:
        db.executescript("""
        create table if not exists meta(k text primary key,v text);
        create table if not exists seen(url text primary key);
        create table if not exists hits(url text primary key,title text,stamp integer);
        create table if not exists devices(endpoint text primary key,sub text);
        create table if not exists queue(url text,endpoint text,primary key(url,endpoint));
        """)

def put(db, key, value):
    db.execute("insert or replace into meta values(?,?)", (key,value))

def norm(s):
    return "".join(unicodedata.normalize("NFKC", s).casefold().split())

def parse(raw):
    root = ET.fromstring(raw)
    if root.tag.split("}")[-1].lower() not in {"rss","rdf","feed"}:
        raise ValueError("RSS 형식을 확인할 수 없음")
    rows = []
    for item in root.iter():
        if item.tag.split("}")[-1] not in {"item","entry"}:
            continue
        title = item.find("{*}title")
        link = item.find("{*}link")
        if title is None or link is None:
            continue
        url = (link.get("href") or link.text or "").strip()
        host = urlsplit(url).hostname or ""
        if urlsplit(url).scheme == "https" and host.endswith(".mandarake.co.jp") and title.text:
            rows.append((url,title.text.strip()))
    if not rows:
        raise ValueError("상품 링크를 찾지 못함")
    return rows

def record(rows):
    now = int(time.time())
    with database() as db:
        meta = dict(db.execute("select k,v from meta"))
        words = [norm(w) for w in meta.get("words","").split(",") if norm(w)]
        for url,title in rows:
            fresh = db.execute("insert or ignore into seen values(?)",(url,)).rowcount
            if fresh and "success" in meta and any(w in norm(title) for w in words):
                db.execute("insert into hits values(?,?,?)",(url,title,now))
                db.execute("insert into queue select ?,endpoint from devices",(url,))
        put(db,"success",str(now))
        put(db,"error","")

def deliver():
    from pywebpush import webpush, WebPushException
    with database() as db:
        pending = list(db.execute("select q.url,q.endpoint,h.title,d.sub from queue q join hits h using(url) join devices d using(endpoint) limit 50"))
    for url,endpoint,title,sub in pending:
        try:
            webpush(subscription_info=json.loads(sub), data=json.dumps(dict(url=url,title=title)),
                    vapid_private_key=os.environ["VAPID_PRIVATE"], vapid_claims={"sub":os.environ["VAPID_SUBJECT"]}, timeout=10)
        except WebPushException as e:
            if getattr(e.response,"status_code",None) not in (404,410):
                continue
            with database() as db:
                db.execute("delete from devices where endpoint=?",(endpoint,))
                db.execute("delete from queue where endpoint=?",(endpoint,))
        else:
            with database() as db:
                db.execute("delete from queue where url=? and endpoint=?",(url,endpoint))

def worker():
    while True:
        start = time.monotonic()
        try:
            res = requests.get(FEED,timeout=20)
            res.raise_for_status()
            record(parse(res.content))
        except Exception as exc:
            with database() as db:
                put(db,"error","피드 확인 실패: "+type(exc).__name__)
        try:
            deliver()
        except Exception:
            app.logger.exception("Push delivery failed")
        time.sleep(max(1,300-(time.monotonic()-start)))

PAGES_ORIGIN = "https://lggommm.github.io"

@app.after_request
def pages_cors(response):
    if request.path.startswith("/api/") and request.headers.get("Origin") == PAGES_ORIGIN:
        response.headers["Access-Control-Allow-Origin"] = PAGES_ORIGIN
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.vary.add("Origin")
    return response

@app.before_request
def protect():
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return "", 204
    if request.path.startswith("/api/") and not hmac.compare_digest(
            request.headers.get("Authorization","").encode(), ("Bearer "+KEY).encode()):
        abort(401)

@app.get("/")
def index():
    return app.send_static_file("index.html")

@app.get("/api/state")
def state():
    with database() as db:
        return jsonify(meta=dict(db.execute("select k,v from meta")),
                       hits=list(db.execute("select title,url,stamp from hits order by stamp desc limit 40")),
                       publicKey=os.environ["VAPID_PUBLIC"])

@app.post("/api/words")
def words():
    value=request.get_json().get("words")
    if not isinstance(value,str) or len(value)>2000:
        abort(400)
    with database() as db:
        put(db,"words",value)
    return "",204

@app.post("/api/device")
def device():
    sub=request.get_json()
    endpoint=sub.get("endpoint","")
    dest=urlsplit(endpoint)
    if (dest.scheme!="https" or dest.hostname not in {"web.push.apple.com","fcm.googleapis.com","updates.push.services.mozilla.com"}
            or dest.username or dest.password or dest.port not in (None,443)
            or not all(sub.get("keys",{}).get(k) for k in ("auth","p256dh"))):
        abort(400)
    with database() as db:
        db.execute("insert or replace into devices values(?,?)",(endpoint,json.dumps(sub)))
    return "",204

if __name__=="__main__":
    from waitress import serve
    init()
    threading.Thread(target=worker,daemon=True).start()
    serve(app,host="0.0.0.0",port=int(os.getenv("PORT","8000")))
