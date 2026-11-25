#!/usr/bin/env node
// Point the extension at your license server (and optionally set the Google OAuth client id / support email).
//   node tools/configure.js --api https://license.yourdomain.com [--oauth 1234-abc.apps.googleusercontent.com] [--email support@meapi.in] [--version 1.0.1]
// Edits js/config.js and manifest.json in place.
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const root = path.join(__dirname, '..');
const cfgPath = path.join(root, 'js', 'config.js');
const manPath = path.join(root, 'manifest.json');

let cfg = fs.readFileSync(cfgPath, 'utf8');
const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));

if (args.api) {
  const u = new URL(args.api);
  const base = u.origin;
  const oldBase = (cfg.match(/API_BASE: '([^']+)'/) || [])[1];
  cfg = cfg.replace(/API_BASE: '[^']*'/, `API_BASE: '${base}'`);
  man.host_permissions = man.host_permissions.filter((h) => !oldBase || !h.startsWith(oldBase));
  man.host_permissions.push(`${base}/*`);
  console.log('API_BASE →', base);
}
if (args.email) { cfg = cfg.replace(/SUPPORT_EMAIL: '[^']*'/, `SUPPORT_EMAIL: '${args.email}'`); console.log('SUPPORT_EMAIL →', args.email); }
if (args.oauth) { man.oauth2.client_id = args.oauth; console.log('oauth2.client_id →', args.oauth); }
if (args.version) { man.version = args.version; console.log('version →', args.version); }

fs.writeFileSync(cfgPath, cfg);
fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
