#!/usr/bin/env bash
# Deploy MeAPI DM (dmsender.meapi.in). Touches ONLY:
#   /www/wwwroot/dmsender.meapi.in/app (this checkout, branch main), PM2 process "meapi-dm".
# Never touches other PM2 apps, nginx, SSL, MariaDB or system packages.
# Run as root:  bash /www/wwwroot/dmsender.meapi.in/app/scripts/deploy.sh
set -euo pipefail
APP=/www/wwwroot/dmsender.meapi.in/app
SRV=$APP/server
NAME=meapi-dm
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$APP"
[ -f "$SRV/.env" ] || fail "$SRV/.env missing"
PORT=$(grep -E '^PORT=' "$SRV/.env" | cut -d= -f2 | tr -d '[:space:]')
[ -n "$PORT" ] || fail "PORT not set in .env"

snap() { pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).filter(p=>p.name!=="meapi-dm").map(p=>p.name+"="+p.pm2_env.status+"/"+p.pid+"/"+p.pm2_env.restart_time).sort().join(" ")))'; }
BEFORE=$(snap)

say "Pull"
git fetch -q origin main
git reset -q --hard origin/main
git log --oneline -1

say "Install + test (tests use an in-memory database, never the live one)"
cd "$SRV"
npm ci --omit=dev --no-audit --no-fund >/dev/null
# Run the tests once; judge by the exit code. The summary line differs between Node versions ("# pass" vs "ℹ pass").
if OUT=$(env -u NODE_OPTIONS npm test 2>&1); then TEST_OK=1; else TEST_OK=; fi
printf '%s\n' "$OUT" | grep -E '^(#|ℹ) (pass|fail) ' || true
[ -n "$TEST_OK" ] || { printf '%s\n' "$OUT" | tail -40; fail "tests failed — live app left running the old code"; }

say "Backup database"
[ -f "$(grep -E '^DATA_DIR=' .env | cut -d= -f2)/meapi-dm.sqlite" ] && node scripts/backup.js || echo "(no database yet)"

say "Restart $NAME"
unset NODE_OPTIONS
if pm2 describe "$NAME" >/dev/null 2>&1; then pm2 reload "$NAME" --update-env >/dev/null; else pm2 start src/index.js --name "$NAME" --cwd "$SRV" --max-memory-restart 300M >/dev/null; fi
ok=; for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && ok=1 && break; sleep 1; done
[ -n "$ok" ] || fail "health check failed — see: pm2 logs $NAME --lines 50"
pm2 save >/dev/null
echo "health: ok on port $PORT"

AFTER=$(snap)
[ "$BEFORE" = "$AFTER" ] && echo "other PM2 apps UNCHANGED" || { echo "WARNING other PM2 apps changed:"; echo "before: $BEFORE"; echo "after:  $AFTER"; }
