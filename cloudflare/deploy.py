import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import time
import urllib.request
from pathlib import Path

account = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
token = os.environ["CLOUDFLARE_API_TOKEN"].strip()
if not re.fullmatch(r"[0-9a-fA-F]{32}", account):
    raise SystemExit("CLOUDFLARE_ACCOUNT_ID must be a 32-digit hexadecimal account ID")
base = f"https://api.cloudflare.com/client/v4/accounts/{account}/"
name = "market-alert-" + os.environ["GITHUB_REPOSITORY_ID"]
def api(path, method="GET", data=None):
    req = urllib.request.Request(base + path, method=method, headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"}, data=json.dumps(data).encode() if data else None)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)["result"]
    except urllib.error.HTTPError as error:
        details = json.loads(error.read()).get("errors", [])
        print("Cloudflare", method, path, "error codes:", [d.get("code") for d in details], flush=True)
        raise

try:
    subdomain = api("workers/subdomain").get("subdomain")
except urllib.error.HTTPError as error:
    if error.code != 404: raise
    subdomain = None
if not subdomain:
    subdomain = name
    api("workers/subdomain","PUT",{"subdomain":subdomain})
db = next((d for d in api("d1/database?name="+name) if d["name"]==name),None)
if not db:
    db = api("d1/database","POST",{"name":name})
config = Path("cloudflare/wrangler.json")
config.write_text(json.dumps({"name":name,"main":"worker.mjs","compatibility_date":"2025-06-01","workers_dev":True,"ai":{"binding":"AI"},"d1_databases":[{"binding":"DB","database_name":name,"database_id":db["uuid"]}]}))
def wrangler(*args, data=None):
    subprocess.run(["npx","--yes","wrangler@4",*args,"--config",str(config)],input=data,text=True,check=True)
wrangler("d1","execute",name,"--remote","--file","cloudflare/schema.sql")
wrangler("deploy")
key = hmac.new(token.encode(),b"market-alert-collector-v1",hashlib.sha256).hexdigest()
wrangler("secret","put","COLLECTOR_TOKEN",data=key)
url = f"https://{name}.{subdomain}.workers.dev"
state_probe_key = secrets.token_hex(32)
pages_origin = "https://lggommm.github.io"
for attempt in range(15):
    try:
        req = urllib.request.Request(url+"/collector/watches",headers={"Authorization": "Bearer " + key, "User-Agent": "MarketAlerts/1.0 (deployment verification)", "Accept": "application/json"})
        with urllib.request.urlopen(req,timeout=15) as response:
            assert isinstance(json.load(response),list)
        state_req = urllib.request.Request(url+"/state", headers={
            "Authorization": "Bearer " + state_probe_key, "Origin": pages_origin,
            "User-Agent": "MarketAlerts/1.0 (deployment verification)", "Accept": "application/json",
        })
        with urllib.request.urlopen(state_req,timeout=15) as response:
            assert response.headers.get("Access-Control-Allow-Origin") == pages_origin
            state = json.load(response)
            assert all(isinstance(state.get(field),list) for field in ("watches","hits","favorites"))
        break
    except urllib.error.HTTPError as error:
        body = error.read(8192)
        edge_code = re.search(rb'(?:error code: |Error )(1[0-9]{3})', body, re.I)
        print("Verification HTTP", error.code, "type", error.headers.get_content_type(),
              "edge code", edge_code.group(1).decode() if edge_code else None, flush=True)
        if attempt == 14:
            raise
        time.sleep(4)
    except OSError:
        if attempt==14: raise
        time.sleep(4)
Path("docs/config.js").write_text("window.MARKET_API = "+json.dumps(url)+";\n")

req = urllib.request.Request(url+"/collector/push-check", headers={"Authorization":"Bearer "+key,"User-Agent":"MarketAlerts/1.0"})
with urllib.request.urlopen(req, timeout=20) as response:
    check=json.load(response)
    print("Push signing and encryption check:",check)
    assert check.get("signature")==64 and check.get("bytes",0)>100
