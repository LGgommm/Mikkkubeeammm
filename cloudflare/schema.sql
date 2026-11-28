PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  shop TEXT NOT NULL CHECK (shop IN ('mercari','nakano')),
  keyword TEXT NOT NULL CHECK (length(keyword) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  initialized INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner, shop, keyword)
);
CREATE TABLE IF NOT EXISTS matches (
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  found_at INTEGER NOT NULL DEFAULT (unixepoch()),
  visible INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(watch_id, url)
);
CREATE TABLE IF NOT EXISTS favorites (
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  saved_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner,url)
);

CREATE TABLE IF NOT EXISTS push_identity (id INTEGER PRIMARY KEY CHECK(id=1), jwk TEXT NOT NULL, public_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, owner TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS push_owner ON push_devices(owner);
CREATE TABLE IF NOT EXISTS listing_push (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL REFERENCES push_devices(endpoint) ON DELETE CASCADE,
  watch_id INTEGER NOT NULL, url TEXT NOT NULL, retry_after INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(watch_id,url) REFERENCES matches(watch_id,url) ON DELETE CASCADE,
  UNIQUE(endpoint,watch_id,url)
);
CREATE INDEX IF NOT EXISTS listing_retry ON listing_push(retry_after,id);
CREATE TRIGGER IF NOT EXISTS queue_listing_detail AFTER INSERT ON matches WHEN NEW.visible=1 BEGIN
  INSERT OR IGNORE INTO listing_push(endpoint,watch_id,url)
    SELECT d.endpoint,NEW.watch_id,NEW.url FROM push_devices d JOIN watches w ON w.owner=d.owner WHERE w.id=NEW.watch_id;
END;
DROP TRIGGER IF EXISTS queue_new_listing;
INSERT OR IGNORE INTO listing_push(endpoint,watch_id,url)
SELECT endpoint,watch_id,url FROM (
  SELECT d.endpoint,m.watch_id,m.url,d.pending,ROW_NUMBER() OVER(PARTITION BY d.endpoint ORDER BY m.found_at DESC,m.rowid DESC) AS position
  FROM push_devices d JOIN watches w ON w.owner=d.owner JOIN matches m ON w.id=m.watch_id
  WHERE d.pending>0 AND m.visible=1
) WHERE position<=pending;
UPDATE push_devices SET pending=0 WHERE pending>0;


CREATE TABLE IF NOT EXISTS push_keys(endpoint TEXT PRIMARY KEY REFERENCES push_devices(endpoint) ON DELETE CASCADE, p256dh TEXT NOT NULL, auth TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS keyword_prices (
  owner TEXT NOT NULL, keyword TEXT NOT NULL, min_yen INTEGER, max_yen INTEGER,
  PRIMARY KEY(owner,keyword)
);
CREATE TRIGGER IF NOT EXISTS cleanup_keyword_price AFTER DELETE ON watches
WHEN NOT EXISTS(SELECT 1 FROM watches WHERE owner=OLD.owner AND keyword=OLD.keyword)
BEGIN
  DELETE FROM keyword_prices WHERE owner=OLD.owner AND keyword=OLD.keyword;
END;

CREATE TABLE IF NOT EXISTS keyword_prices_krw (
  owner TEXT NOT NULL, keyword TEXT NOT NULL, min_krw INTEGER NOT NULL, max_krw INTEGER NOT NULL,
  PRIMARY KEY(owner,keyword), CHECK(min_krw >= 0 AND min_krw <= max_krw AND max_krw <= 1000000)
);
CREATE TRIGGER IF NOT EXISTS cleanup_keyword_price_krw AFTER DELETE ON watches
WHEN NOT EXISTS(SELECT 1 FROM watches WHERE owner=OLD.owner AND keyword=OLD.keyword)
BEGIN
  DELETE FROM keyword_prices_krw WHERE owner=OLD.owner AND keyword=OLD.keyword;
END;

CREATE TABLE IF NOT EXISTS listing_times (url TEXT PRIMARY KEY, posted_at INTEGER NOT NULL);
