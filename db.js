const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'dawaat.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,
  groom_name    TEXT NOT NULL,
  bride_name    TEXT NOT NULL,
  event_date    TEXT,           -- ISO date, e.g. 2026-10-14
  event_time    TEXT,           -- e.g. 19:00
  venue         TEXT,
  plan          TEXT NOT NULL DEFAULT 'featured',  -- basic | featured | luxury
  style         TEXT NOT NULL DEFAULT 'v1',         -- v1 | v2 | v3
  phone         TEXT,
  note          TEXT,
  video_url     TEXT,           -- link to the opening video once produced
  photo_url     TEXT,           -- couple's photo, uploaded via the order form or admin
  status        TEXT NOT NULL DEFAULT 'lead', -- lead | confirmed | paid | published
  source        TEXT NOT NULL DEFAULT 'admin', -- admin | landing_form
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(order_id, slug)
);

CREATE TABLE IF NOT EXISTS rsvps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  guest_id    INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  attending   TEXT NOT NULL,   -- yes | no | maybe
  guest_count INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guests_order ON guests(order_id);
CREATE INDEX IF NOT EXISTS idx_rsvps_order ON rsvps(order_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS stickers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration: add columns to orders if this is an existing database from
// before these columns existed. SQLite has no "ADD COLUMN IF NOT EXISTS",
// so check first.
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderColumns.includes('photo_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN photo_url TEXT');
}
if (!orderColumns.includes('music_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN music_url TEXT');
}
if (!orderColumns.includes('sticker_urls')) {
  db.exec('ALTER TABLE orders ADD COLUMN sticker_urls TEXT');
}
if (!orderColumns.includes('viewed_at')) {
  db.exec('ALTER TABLE orders ADD COLUMN viewed_at TEXT');
}
if (!orderColumns.includes('bride_photo_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN bride_photo_url TEXT');
}
if (!orderColumns.includes('groom_photo_url')) {
  db.exec('ALTER TABLE orders ADD COLUMN groom_photo_url TEXT');
}

module.exports = db;
