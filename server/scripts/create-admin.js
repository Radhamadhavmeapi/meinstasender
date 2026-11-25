#!/usr/bin/env node
// Create (or reset the password of) an admin for /admin.
//   npm run create-admin -- --email you@example.com [--name "Ankit"]
// The password is asked for on the terminal (not shown, not stored in shell history).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const readline = require('readline');
const { open } = require('../src/db');
const { hashPassword, normEmail, EMAIL_RE, validPassword } = require('../src/auth');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const email = normEmail(args.email);
if (!EMAIL_RE.test(email)) { console.error('Usage: npm run create-admin -- --email you@example.com [--name Name]'); process.exit(1); }

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const pw = process.env.ADMIN_PASSWORD || (await askHidden('Password (min 8 chars): '));
  if (!validPassword(pw)) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  if (!process.env.ADMIN_PASSWORD) {
    const again = await askHidden('Repeat password: ');
    if (again !== pw) { console.error('Passwords do not match.'); process.exit(1); }
  }
  const db = open(path.resolve(path.join(__dirname, '..'), process.env.DATA_DIR || './data', 'meapi-dm.sqlite'));
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(pw), existing.id);
    db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ?").run(existing.id);
    console.log(`Password reset for admin ${email}.`);
  } else {
    db.prepare('INSERT INTO admins(email, password_hash, name, created_at) VALUES (?, ?, ?, ?)').run(email, hashPassword(pw), args.name || null, Date.now());
    console.log(`Admin ${email} created. Sign in at ${process.env.PUBLIC_URL || ''}/admin`);
  }
})();
