// SQLite storage for the MeAPI DM license server.
// One file, WAL mode. All times are unix milliseconds unless the column name says otherwise.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS licenses (
  key          TEXT PRIMARY KEY,
  user_id      INTEGER,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  created_ip   TEXT,
  version      TEXT,
  banned       INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);

-- Website / extension accounts. role: 'user' | 'reseller'. reseller_id = the reseller who created this customer.
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,
  google_sub      TEXT UNIQUE,
  name            TEXT,
  phone           TEXT,
  role            TEXT NOT NULL DEFAULT 'user',
  reseller_status TEXT NOT NULL DEFAULT 'none',   -- none | pending | approved | rejected
  reseller_note   TEXT,
  reseller_id     INTEGER,
  credits         INTEGER NOT NULL DEFAULT 0,
  license_key     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_reseller ON users(reseller_id);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,          -- 'user' | 'admin'
  subject_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(kind, subject_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entitlements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'pro' | 'pass'
  source      TEXT NOT NULL,            -- 'razorpay_sub' | 'razorpay_link' | 'admin' | 'manual' | 'reseller'
  ref         TEXT,
  product_code TEXT,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ent_key ON entitlements(license_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ent_ref ON entitlements(source, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT PRIMARY KEY,
  license_key  TEXT NOT NULL,
  product_code TEXT,
  status       TEXT NOT NULL,
  current_end  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  license_key TEXT NOT NULL,
  day         TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (license_key, day)
);

CREATE TABLE IF NOT EXISTS products (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,         -- 'subscription' | 'pass' | 'credits'
  price_paise     INTEGER NOT NULL,
  price_usd_cents INTEGER,               -- PayPal price; null = PayPal not offered for this product
  credits         INTEGER,               -- kind 'credits': how many reseller credits the pack gives
  currency        TEXT NOT NULL DEFAULT 'INR',
  interval_label  TEXT,                  -- 'month' | 'year'
  duration_hours  INTEGER,               -- passes
  razorpay_plan_id TEXT,                 -- subscriptions
  features        TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key  TEXT,
  user_id      INTEGER,
  product_code TEXT,
  method       TEXT NOT NULL DEFAULT 'razorpay',
  razorpay_id  TEXT,
  amount_paise INTEGER,
  currency     TEXT,
  event        TEXT,
  created_at   INTEGER NOT NULL
);

-- UPI / PayPal / bank transfer: user submits a reference, admin approves.
CREATE TABLE IF NOT EXISTS manual_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  product_code  TEXT NOT NULL,
  method        TEXT NOT NULL,       -- upi | paypal | bank
  amount        INTEGER NOT NULL,    -- minor units
  currency      TEXT NOT NULL,
  reference     TEXT,
  proof_file    TEXT,
  user_note     TEXT,
  status        TEXT NOT NULL,       -- awaiting | pending | approved | rejected | cancelled
  admin_note    TEXT,
  decided_by    INTEGER,
  created_at    INTEGER NOT NULL,
  submitted_at  INTEGER,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mp_status ON manual_payments(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_ref ON manual_payments(method, reference) WHERE reference IS NOT NULL AND status IN ('pending', 'approved');

CREATE TABLE IF NOT EXISTS credit_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  delta      INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  reason     TEXT NOT NULL,          -- purchase | admin | activate
  ref        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS checkouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key  TEXT NOT NULL,
  user_id      INTEGER,
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
  level       TEXT NOT NULL DEFAULT 'info',
  lang        TEXT,
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
  pass_offer_code: 'pass24',   // product shown in the "limit reached" popup; '' = none
  credits_per_month: '1',      // reseller credits for 1 month (30 days) of PRO for one customer
  pay_razorpay: '1',           // payment methods shown in the portal ('1' / '0')
  pay_upi: '0',
  pay_paypal: '0',
  pay_bank: '0',
  upi_id: '',
  upi_name: '',
  paypal_link: '',             // e.g. https://paypal.me/yourname
  paypal_email: '',
  bank_details: '',            // free text: account name, number, IFSC, bank, branch
  extension_url: '',           // Chrome Web Store or direct download link
  support_email: '',
  support_whatsapp: '',
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  seedProducts(db);
  return db;
}

// Starter catalogue so a fresh install works. Edit prices / plan ids in the admin panel.
function seedProducts(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) return;
  const ins = db.prepare(`INSERT INTO products(code, name, kind, price_paise, price_usd_cents, credits, currency, interval_label, duration_hours, razorpay_plan_id, features, active, sort)
    VALUES (@code, @name, @kind, @price_paise, @price_usd_cents, @credits, 'INR', @interval_label, @duration_hours, @razorpay_plan_id, @features, 1, @sort)`);
  const f = (a) => JSON.stringify(a);
  const rows = [
    { code: 'pass24', name: '24-hour pass', kind: 'pass', price_paise: 9900, price_usd_cents: 199, credits: null, interval_label: null, duration_hours: 24, razorpay_plan_id: null,
      features: f(['Up to 100 DMs per Instagram account for 24 hours', 'No subscription']), sort: 1 },
    { code: 'pro_month', name: 'PRO Monthly', kind: 'subscription', price_paise: 49900, price_usd_cents: 799, credits: null, interval_label: 'month', duration_hours: null, razorpay_plan_id: '',
      features: f(['Up to 100 DMs per Instagram account per day', 'Unlimited campaigns', 'Followers / following import', 'Priority support']), sort: 2 },
    { code: 'pro_year', name: 'PRO Yearly', kind: 'subscription', price_paise: 399900, price_usd_cents: 6499, credits: null, interval_label: 'year', duration_hours: null, razorpay_plan_id: '',
      features: f(['Everything in PRO Monthly', '2 months free']), sort: 3 },
    { code: 'credits10', name: '10 reseller credits', kind: 'credits', price_paise: 299900, price_usd_cents: 3999, credits: 10, interval_label: null, duration_hours: null, razorpay_plan_id: null,
      features: f(['10 customer-months of PRO', 'Activate or renew any of your customers']), sort: 10 },
    { code: 'credits50', name: '50 reseller credits', kind: 'credits', price_paise: 1249900, price_usd_cents: 16999, credits: 50, interval_label: null, duration_hours: null, razorpay_plan_id: null,
      features: f(['50 customer-months of PRO', 'Lowest price per credit']), sort: 11 },
  ];
  db.transaction(() => rows.forEach((r) => ins.run(r)))();
}

module.exports = { open, SETTING_KEYS, DEFAULT_SETTINGS };
