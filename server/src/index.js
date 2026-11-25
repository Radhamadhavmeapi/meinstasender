// Entry point: node src/index.js  (reads .env from the server folder)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { open } = require('./db');
const { createApp } = require('./app');
const { createClient } = require('./razorpay');

const env = process.env;
const dataDir = path.resolve(path.join(__dirname, '..'), env.DATA_DIR || './data');
const config = {
  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '127.0.0.1',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  extensionIds: (env.EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  issuePerHour: parseInt(env.ISSUE_PER_HOUR || '10', 10),
  perMinute: parseInt(env.RATE_PER_MINUTE || '120', 10),
  uploadDir: path.join(dataDir, 'uploads'),
  notifyEmail: env.NOTIFY_EMAIL || '',
  smtp: { host: env.SMTP_HOST || '', port: parseInt(env.SMTP_PORT || '587', 10), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || '' },
};

if (!config.publicUrl) console.warn('[warn] PUBLIC_URL not set — password-reset links and Razorpay return URLs will be wrong.');
const razorpay = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? createClient({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }) : null;
if (!razorpay) console.warn('[warn] Razorpay keys not set — online checkout is disabled (manual methods still work).');

const db = open(path.join(dataDir, 'meapi-dm.sqlite'));
if (db.prepare('SELECT COUNT(*) n FROM admins').get().n === 0) console.warn('[warn] No admin yet — run: npm run create-admin');
const { app } = createApp({ db, config, razorpay });
app.listen(config.port, config.host, () => console.log(`MeAPI DM server on ${config.host}:${config.port}`));
