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
