// Entry point: node src/index.js  (reads .env)
require('dotenv').config();
const { open } = require('./db');
const { createApp } = require('./app');
const { createClient } = require('./razorpay');

const env = process.env;
const config = {
  port: parseInt(env.PORT || '8787', 10),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  adminToken: env.ADMIN_TOKEN || '',
  extensionIds: (env.EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  issuePerHour: parseInt(env.ISSUE_PER_HOUR || '10', 10),
  perMinute: parseInt(env.RATE_PER_MINUTE || '120', 10),
};

if (config.adminToken.length < 16) console.warn('[warn] ADMIN_TOKEN missing or shorter than 16 chars — admin API is disabled.');
const razorpay = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
  ? createClient({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET })
  : null;
if (!razorpay) console.warn('[warn] Razorpay keys not set — checkout is disabled.');

const db = open(env.DB_FILE || './data/meapi-dm.sqlite');
const { app } = createApp({ db, config, razorpay });
app.listen(config.port, '127.0.0.1', () => console.log(`MeAPI DM license server on 127.0.0.1:${config.port}`));
