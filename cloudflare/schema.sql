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
CREATE TRIGGER IF NOT EXISTS queue_new_listing AFTER INSERT ON matches WHEN NEW.visible=1 BEGIN
  UPDATE push_devices SET pending=pending+1 WHERE owner=(SELECT owner FROM watches WHERE id=NEW.watch_id);
END;

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
