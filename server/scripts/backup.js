#!/usr/bin/env node
// Online SQLite backup (safe while the server runs). Keeps the newest 14 copies.
//   node scripts/backup.js        → $DATA_DIR/backups/meapi-dm-YYYY-MM-DD-HHMM.sqlite
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const Database = require('better-sqlite3');

const dataDir = path.resolve(path.join(__dirname, '..'), process.env.DATA_DIR || './data');
const src = path.join(dataDir, 'meapi-dm.sqlite');
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : c === ':' ? '' : '-'));
const out = path.join(dir, `meapi-dm-${stamp}.sqlite`);
const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(out).then(() => {
  fs.chmodSync(out, 0o600);
  const files = fs.readdirSync(dir).filter((f) => /^meapi-dm-.*\.sqlite$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(dir, f));
  console.log('backup ok:', out);
}).catch((e) => { console.error('backup failed:', e.message); process.exit(1); });
