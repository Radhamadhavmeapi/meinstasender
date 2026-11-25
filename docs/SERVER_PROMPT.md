# Prompt for the server Claude (104.251.222.21) — first deploy of MeAPI DM Sender

Paste everything below the line into a NEW tmux session on the server:
`tmux new -s meapi-dm`, then `claude`. Don't reuse the WaBaCRM or WBotCRM sessions.

---

You are deploying a NEW, separate app on this shared server: **MeAPI DM Sender** (Instagram DM Chrome extension backend + website + user/reseller portal + admin) for the domain **dmsender.meapi.in**.

## Isolation rules (this server runs live products)
- NEVER change, restart or stop any other app. Live PM2 processes include wcrmpro, whatsway, WAZIPER-8099, newlic-backend, wabacrm-license, wbotcrm-license (check `pm2 list` for the full set). Only ever start/reload/stop the PM2 process named **meapi-dm**. No `pm2 restart all`, no `pm2 kill`, no `pm2 update`.
- NEVER touch other sites' folders, .env files, databases or nginx vhosts (login.waba-crm.com, login.wbotcrm.com, wbotcrm.com, MeAPI sites, etc.). Read-only reference of their nginx config is fine.
- nginx: change ONLY the vhost for dmsender.meapi.in. Always `nginx -t` before `nginx -s reload`. Never restart or stop nginx.
- SSL: issue the certificate for dmsender.meapi.in only (aaPanel SSL tab or certbot for that single domain). Never run certbot commands that touch other certificates.
- This app uses its own SQLite file — do NOT create or touch any MySQL/MariaDB database, and never read the aaPanel MySQL root password.
- Don't change global Node/npm, global packages, firewall, SSH, OS packages or cron lines you didn't add. If something system-level is needed (e.g. build tools for better-sqlite3), STOP and ask me.
- Never print secrets (.env values, passwords, keys) in chat. .env is chmod 600 and lives outside the web root.
- GitHub access is read-only (deploy key). Never push.

## Facts
- Repo: git@github.com:Radhamadhavmeapi/meinstasender.git, branch `main`. Code layout: `server/` (Node app), `extension/` (Chrome extension), `scripts/deploy.sh`.
- The aaPanel site was created by mistake as **dmsender.mepai.in** (typo) at /www/wwwroot/dmsender.mepai.in. The correct domain is **dmsender.meapi.in**. I (the owner) will fix that in aaPanel — see step 0.
- App needs Node ≥ 20. It listens on 127.0.0.1 only. RAM ~80–150 MB. Disk ~60 MB plus data.

## Step 0 — read-only check, then WAIT for my OK
Report, changing nothing:
1. `pm2 list` (names, status, restarts) and `ss -ltnp` → propose a free port (prefer 3230; must not be 3210/3220/3221 or anything in use).
2. `node -v`, `npm -v`, `free -h`, `df -h /www`, and whether `make`, `g++` and `python3` exist (only needed if better-sqlite3 has no prebuilt binary).
3. `dig +short dmsender.meapi.in A` and `dig +short dmsender.meapi.in A @1.1.1.1` → must be 104.251.222.21. If not, tell me to add the DNS A record.
4. Does /www/wwwroot/dmsender.meapi.in exist and is there an aaPanel nginx vhost for it? Show `ls -la` of the folder and the vhost's server_name/root/location lines. Also say whether the typo site dmsender.mepai.in exists — do NOT delete it; I'll remove it in aaPanel.
5. A deploy key: create `ssh-keygen -t ed25519 -N "" -C meapi-dm-deploy -f /root/.ssh/meinstasender_deploy` (only if it doesn't exist), add a Host alias `github-meinstasender` for it in /root/.ssh/config (append only, don't change existing entries), and print ONLY the PUBLIC key so I can add it in GitHub → repo Settings → Deploy keys (read-only).
Then give me your plan (port, PM2 name meapi-dm, folders, nginx changes) and wait.

## Step 1 — code and config (after my OK)
- Folder layout inside /www/wwwroot/dmsender.meapi.in:
  - `app/` = `git clone github-meinstasender:Radhamadhavmeapi/meinstasender.git app` (branch main)
  - `data/` = database, payment screenshots, backups (chmod 700)
  - the aaPanel web root stays as it is; nginx sends everything to Node, so nothing in app/ or data/ is served as a file.
- Create `app/server/.env` from `app/server/.env.example` (chmod 600): PORT = the agreed port, HOST=127.0.0.1, PUBLIC_URL=https://dmsender.meapi.in, DATA_DIR=/www/wwwroot/dmsender.meapi.in/data. Leave Razorpay and SMTP empty for now unless I give you values in this terminal. List the keys you set (mask secrets).
- `cd app/server && npm ci --omit=dev && npm test` (tests use an in-memory DB; all must pass).

## Step 2 — run
- `bash /www/wwwroot/dmsender.meapi.in/app/scripts/deploy.sh` (it starts PM2 process meapi-dm, checks /health and confirms the other PM2 apps are unchanged).
- Create the first admin: `cd app/server && npm run create-admin -- --email <ask me> --name Ankit`. It asks for the password on the terminal; I will type it myself.

## Step 3 — nginx for dmsender.meapi.in only
Replace the PHP/static handling in its vhost with a reverse proxy (keep the certificate and HTTP→HTTPS redirect lines aaPanel manages):
```
client_max_body_size 6m;
location / {
    proxy_pass http://127.0.0.1:<PORT>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}
```
Make sure no aaPanel rule blocks `.json`/`.js` under `/users/`, `/admin/`, `/shared/`, `/v1/` or `/api/`. `nginx -t`, then `nginx -s reload`. Issue SSL for dmsender.meapi.in if not yet issued.

## Step 4 — backups (own cron line only)
Add one crontab line: `17 3 * * * cd /www/wwwroot/dmsender.meapi.in/app/server && /usr/bin/env node scripts/backup.js >> /www/wwwroot/dmsender.meapi.in/data/backup.log 2>&1` (use the full node path from `which node`). Keeps 14 daily copies in data/backups.

## Step 5 — checks, then report
- `curl -s https://dmsender.meapi.in/health` → {"ok":true}
- HTTP 200 for https://dmsender.meapi.in/ , /users/ , /admin/ , /privacy , /terms , /refund
- `curl -s https://dmsender.meapi.in/v1/products` lists products
- `pm2 list`: every other app has the same PID and restart count as in step 0.
- The other live sites still load: login.waba-crm.com, login.wbotcrm.com, wbotcrm.com.
Report each result briefly. For later updates, I'll just say "deploy meapi-dm" and you run scripts/deploy.sh.
