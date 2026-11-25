// SQLite storage for the MeAPI DM license server.
// One file, WAL mode. All times are unix milliseconds unless the column name says otherwise.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS licenses (
  key          TEXT PRIMARY KEY,
  account_id   INTEGER,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  created_ip   TEXT,
  version      TEXT,
  banned       INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_account ON licenses(account_id);

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT UNIQUE NOT NULL,
  google_sub  TEXT UNIQUE,
  name        TEXT,
  license_key TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'pro' | 'pass'
  source      TEXT NOT NULL,            -- 'razorpay_sub' | 'razorpay_link' | 'admin'
  ref         TEXT,                     -- razorpay subscription / payment id
  product_code TEXT,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ent_key ON entitlements(license_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ent_ref ON entitlements(source, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT PRIMARY KEY,        -- razorpay sub_xxx
  license_key  TEXT NOT NULL,
  product_code TEXT,
  status       TEXT NOT NULL,
  current_end  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  license_key TEXT NOT NULL,
  day         TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (license_key, day)
);

CREATE TABLE IF NOT EXISTS products (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,         -- 'subscription' | 'pass'
  price_paise    INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  interval_label TEXT,                  -- 'month' | 'year' (display only)
  duration_hours INTEGER,               -- for passes; subscriptions follow razorpay current_end
  razorpay_plan_id TEXT,                -- for subscriptions
  features       TEXT,                  -- JSON array of strings
  active         INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key  TEXT,
  product_code TEXT,
  razorpay_id  TEXT,
  amount_paise INTEGER,
  currency     TEXT,
  event        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key  TEXT NOT NULL,
  product_code TEXT NOT NULL,
  razorpay_id  TEXT,
  url          TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  link_url    TEXT,
  link_label  TEXT,
  level       TEXT NOT NULL DEFAULT 'info', -- 'info' | 'warning' | 'critical'
  lang        TEXT,                          -- null = all
  min_version TEXT,
  max_version TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  starts_at   INTEGER,
  ends_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT,
  name        TEXT NOT NULL,
  props       TEXT,
  version     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,
  event       TEXT,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  free_daily_limit: '10',      // free sends per license per UTC day
  pro_daily_cap: '100',        // hard cap per IG account per day (extension enforces too)
  pass_offer_code: 'pass24',   // product code shown in the "limit reached" popup; '' = none
};

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  seedProducts(db);
  return db;
}

// Starter catalogue so a fresh install works. Edit prices / plan ids in the admin panel.
function seedProducts(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (n > 0) return;
  const ins = db.prepare(`INSERT INTO products(code, name, kind, price_paise, currency, interval_label, duration_hours, razorpay_plan_id, features, active, sort)
    VALUES (@code, @name, @kind, @price_paise, @currency, @interval_label, @duration_hours, @razorpay_plan_id, @features, 1, @sort)`);
  const rows = [
    { code: 'pass24', name: '24-hour pass', kind: 'pass', price_paise: 9900, currency: 'INR', interval_label: null, duration_hours: 24, razorpay_plan_id: null,
      features: JSON.stringify(['Up to 100 DMs per Instagram account for 24 hours', 'No subscription']), sort: 1 },
    { code: 'pro_month', name: 'PRO Monthly', kind: 'subscription', price_paise: 49900, currency: 'INR', interval_label: 'month', duration_hours: null, razorpay_plan_id: '',
      features: JSON.stringify(['Up to 100 DMs per Instagram account per day', 'Unlimited campaigns', 'Followers / following import', 'Priority support']), sort: 2 },
    { code: 'pro_year', name: 'PRO Yearly', kind: 'subscription', price_paise: 399900, currency: 'INR', interval_label: 'year', duration_hours: null, razorpay_plan_id: '',
      features: JSON.stringify(['Everything in PRO Monthly', '2 months free']), sort: 3 },
  ];
  const tx = db.transaction(() => rows.forEach((r) => ins.run(r)));
  tx();
}

module.exports = { open };
