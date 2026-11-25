# MeAPI DM – Bulk DM Sender for Instagram

There are two parts:

| Folder | What it is |
|---|---|
| `extension/` | The Chrome extension (Manifest V3). Customers install this. |
| `server/` | Your license server (Node.js + SQLite + Razorpay). It runs on your VPS. |

---

## 1. What the extension does

- **Recipients:** type or paste usernames; import Excel or CSV (every extra column becomes a `{{variable}}`); collect an account's **followers** or **following**; paste cells straight from Excel with Ctrl+V. Undo and redo are built in, and duplicates are removed automatically.
- **Message:** variables (`{{name}}`, `{{first_name|there}}`, any column) and spintax (`{Hi|Hello|Hey}`). A live phone preview shows the exact text each person will get.
- **Safe sending:**
  - Pacing is a random 1–2× gap between messages (at least 20 s).
  - After every 10 attempts there's a 30–240 min break.
  - The daily limit is per Instagram account, with a hard cap of 100.
  - Anyone this browser already messaged is skipped.
  - It stops automatically when Instagram limits the account (with a 24 h cooldown), when the user logs out, or when the account switches mid-run.
  - It pauses automatically when the internet drops (and resumes on reconnect) or when the Instagram tab is lost.
  - After 3 failures in a row it cools off for 30 minutes and tries once more.
- **Campaigns:** lists are saved, and large lists continue across days. You can resume, retry failed people, rename, end, delete, or export to Excel.
- **History:** every attempt is logged. You can search and filter it, export it to CSV or JSON, and "allow messaging again" for one person.
- **Account status:** today's count for each Instagram account and any active cooldown, with help switching accounts.
- **Self-test:** checks each step in order: license server → Instagram login → Instagram tab → user lookup → chat connection. An optional real DM to yourself is also available.
- **Plans:**
  - Free daily limit, set on your server.
  - 24-hour pass and PRO monthly or yearly, paid through **Razorpay**.
  - Optional **Google sign-in** so a plan follows the user to other PCs.
  - License-key copy, paste and restore.
- **Other:** in-app notices that you publish from the admin panel, and English plus हिन्दी.

How sending works: the extension uses the customer's own logged-in Instagram session. It looks up the user ID, opens the DM thread from a pinned background Instagram tab, and publishes the message over Instagram's web chat connection (MQTT over WebSocket). This is the same route instagram.com itself uses.

> **Risk notice.** Automated DMs break Instagram's Terms of Use. Customers' accounts can be limited or banned, and Meta has taken legal action against automation tools before. Keep the safety limits in place. Also make sure your store listing and website say clearly that users send at their own risk.

---

## 2. Deploy the license server (VPS)

Requirements: Ubuntu 22.04+ (or similar), Node.js 20+, nginx, and a domain such as `license.yourdomain.com`.

```bash
# on the VPS
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

# upload the server/ folder, then:
cd /opt/meapi-dm/server
npm ci --omit=dev
cp .env.example .env && nano .env        # fill in everything (see below)
npm test                                  # 6 tests should pass
pm2 start src/index.js --name meapi-dm && pm2 save && pm2 startup
```

The server listens on `127.0.0.1:8787`. Put nginx in front of it:

```nginx
server {
  server_name license.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then run `sudo certbot --nginx -d license.yourdomain.com` for HTTPS.

**`.env` values**

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://license.yourdomain.com` |
| `ADMIN_TOKEN` | Long random string. Create one with `openssl rand -hex 32` |
| `EXTENSION_IDS` | Your Chrome Web Store extension ID. Leave it empty while testing. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → Account & Settings → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | The secret you type when you create the webhook (below) |

**Backups:** everything is in `data/meapi-dm.sqlite`. Copy it daily, for example with cron and `sqlite3 data/meapi-dm.sqlite ".backup /backups/mdm-$(date +%F).sqlite"`.

### Admin panel

Open `https://license.yourdomain.com/admin` and paste your `ADMIN_TOKEN`.
- **Dashboard:** installs, active users, payers, DMs per day, 30-day revenue, and usage events.
- **Licenses:** search by key or email, grant PRO or a pass for N hours, revoke, ban, and reset today's usage.
- **Products:** prices, features and Razorpay plan IDs.
- **Notices:** pop-up messages inside the extension, which you can limit by version or language.
- **Settings:** free DMs per day, daily cap per account, and which pass is offered when a user hits the limit.
- **Payments:** the payment log.

### Razorpay setup

1. **Plans (for PRO):** Dashboard → Subscriptions → Plans. Create a monthly plan (for example ₹499) and a yearly plan (for example ₹3,999). Copy each `plan_…` ID into **Admin → Products** (`pro_month`, `pro_year`). Until a plan ID is filled in, that card shows "Coming soon".
2. **24-hour pass:** nothing to create, because it's sold through payment links. Set the price in Admin → Products → `pass24`.
3. **Webhook:** Dashboard → Settings → Webhooks → Add.
   - URL: `https://license.yourdomain.com/v1/webhooks/razorpay`
   - Secret: same as `RAZORPAY_WEBHOOK_SECRET`
   - Events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`, `payment_link.paid`
4. Test everything in **Test Mode** first with `rzp_test_…` keys.

Every webhook is signature-checked and processed only once. PRO lasts until Razorpay's `current_end` plus 6 hours of grace. Passes stack: buying a second one adds 24 hours after the current pass ends. Refunds are manual: refund in Razorpay, then **Revoke** the entitlement in the admin panel.

---

## 3. Build and publish the extension

```bash
cd extension
node tools/configure.js --api https://license.yourdomain.com --email support@meapi.in
```

That single command updates `js/config.js` and the host permission in `manifest.json`.

**Load it for testing:** go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose the `extension/` folder. Log in to instagram.com in the same Chrome profile, then click the extension icon and run **Self-test**.

**Optional Google sign-in:**
1. Upload the extension to the Chrome Web Store once (it can stay as an unpublished draft) to get its permanent ID.
2. In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type **Chrome Extension** and enter that ID.
3. Run `node tools/configure.js --oauth <client-id>.apps.googleusercontent.com`.
4. Put the same extension ID in the server's `EXTENSION_IDS`.

If you skip this, everything else still works: licenses are tied to the browser key, which users can copy to another PC.

**Package it:** zip the *contents* of `extension/` without `tests/`, then upload in the Chrome Web Store Developer Dashboard.
- **Store review:** reviewers often reject or remove Instagram automation tools. Describe the extension honestly ("you start every run; built-in daily limits and pacing"). Keep a direct-download zip on your website as a backup channel.
- **Privacy policy:** you need one. Say that usernames, messages and history stay in the user's browser, and that your server only stores the license key, daily send counts, optional Google email, payment records and anonymous usage events.

---

## 4. Tests

```bash
cd server && npm test                           # licensing, limits, Razorpay webhooks, Google link, admin API
cd extension && node --test tests/*.test.js     # queue: pacing, limits, stops, pause/resume, account switch, retries
```

## 5. When Instagram changes something

The code that talks to Instagram lives in three files:

| File | What it handles |
|---|---|
| `extension/content.js` | Thread creation (`fb_dtsg` token) and the MQTT publish |
| `extension/js/ig.js` | Profile lookup, followers and following paging, session cookies |
| `extension/js/policy.js` | `classify()`, which maps Instagram's error text to a stop, pause or retry |

When users report failures, have them run **Self-test → Raw report** and send it to you. It shows which step broke.

## 6. Third-party code

- Paho MQTT (EPL-1.0 / EDL-1.0)
- SheetJS Community Edition (Apache-2.0)
- Tabulator (MIT)

Their licenses are in `extension/vendor/licenses/`.
