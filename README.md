# MeAPI DM – Bulk DM Sender for Instagram

There are two parts:

| Folder | What it is |
|---|---|
| `extension/` | The Chrome extension (Manifest V3). Customers install this. |
| `server/` | Website, user/reseller portal, admin panel and licence API (Node.js + SQLite). It runs at dmsender.meapi.in. |

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

## 2. Server: website, user/reseller portal, admin, licence API

One Node app (`server/`) serves everything on **https://dmsender.meapi.in**:

| Path | What |
|---|---|
| `/` | Landing page, plus `/privacy`, `/terms` and `/refund` |
| `/users/` | User and reseller portal: sign up, sign in, buy or renew, payments, profile, and "My customers" for resellers |
| `/admin/` | Admin panel (email + password): payments to approve, users, resellers and credits, browser licences, plans and prices, notices, settings, payment log, admins |
| `/v1/*` | Extension API (licence key, limits, Razorpay checkout and webhook, email/Google sign-in) |

**Accounts.** The same email and password work on the website and in the extension (Plan → Sign in with email). The free plan works without an account.

**Resellers.** A user applies from the portal, and you approve them in Admin → Resellers. Resellers then:
- buy credit packs, by Razorpay or a manual method;
- create customer accounts;
- spend `credits_per_month` credits per customer-month to switch on PRO for 1, 3, 6 or 12 months.

**Payment methods.** Switch these on in Admin → Settings:
- **Razorpay:** automatic. Needs the keys in `.env` and the webhook set up.
- **UPI QR:** a QR code is generated with the exact amount.
- **PayPal:** a PayPal.me link, using each plan's USD price.
- **Bank transfer.**

The three manual methods work the same way: the customer enters the UTR or transaction ID, with an optional screenshot, then you approve it in Admin → Payments to approve. Approving switches on the plan or adds the credits.

**Storage.** One SQLite file plus uploaded screenshots in `DATA_DIR`. `server/scripts/backup.js` makes safe live backups and keeps 14.

**Deploy.** See `docs/SERVER_PROMPT.md` for the first setup on the shared server. After that, run `bash scripts/deploy.sh`, which:
- pulls the latest code;
- runs the tests;
- backs up the database;
- reloads only the PM2 process `meapi-dm`;
- checks that health is OK and that the other apps are unchanged.

First admin: `cd server && npm run create-admin -- --email you@meapi.in`.

### Razorpay setup

1. **Plans (for PRO):** Dashboard → Subscriptions → Plans. Create a monthly and a yearly plan, then paste each `plan_…` ID into **Admin → Plans & prices**. Until then, the PRO cards send people to the website to pay by UPI, bank or PayPal.
2. **Passes and credit packs:** these are sold through payment links, so there's nothing to create in Razorpay.
3. **Webhook:** Dashboard → Settings → Webhooks.
   - URL: `https://dmsender.meapi.in/v1/webhooks/razorpay`
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
   - Events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`, `payment_link.paid`

## 3. Build and publish the extension

```bash
cd extension
node tools/configure.js --api https://dmsender.meapi.in --email support@meapi.in   # already done in this repo
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
cd server && npm test                           # licences, limits, Razorpay, accounts, manual payments, resellers, admin
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
