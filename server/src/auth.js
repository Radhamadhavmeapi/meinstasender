// Passwords (scrypt), cookie sessions for the /users portal and /admin panel, and request guards.
const crypto = require('crypto');

const SESSION_DAYS = { user: 30, admin: 7 };
const COOKIE = { user: 'mdm_u', admin: 'mdm_a' };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, h] = stored.split('$');
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
// Same cost as a real check, so "no such email" and "wrong password" take the same time.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSessions(db, { secureCookies, now = () => Date.now() }) {
  const q = {
    ins: db.prepare('INSERT INTO sessions(token_hash, kind, subject_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?'),
    del: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    delAll: db.prepare('DELETE FROM sessions WHERE kind = ? AND subject_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  function cookieStr(name, value, maxAgeSec) {
    return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', secureCookies ? 'Secure' : null, `Max-Age=${maxAgeSec}`]
      .filter(Boolean).join('; ');
  }

  function start(res, req, kind, subjectId) {
    const token = randomToken();
    const t = now();
    const days = SESSION_DAYS[kind];
    q.ins.run(sha256(token), kind, subjectId, t, t + days * 86400000, req.ip || null, String(req.get('user-agent') || '').slice(0, 200));
    res.append('Set-Cookie', cookieStr(COOKIE[kind], token, days * 86400));
    if (Math.random() < 0.05) q.purge.run(t);
    return token;
  }
  function read(req, kind) {
    const token = parseCookies(req.get('cookie'))[COOKIE[kind]];
    if (!token) return null;
    const s = q.get.get(sha256(token), kind);
    if (!s || s.expires_at < now()) return null;
    return s;
  }
  function end(req, res, kind) {
    const token = parseCookies(req.get('cookie'))[COOKIE[kind]];
    if (token) q.del.run(sha256(token));
    res.append('Set-Cookie', cookieStr(COOKIE[kind], '', 0));
  }
  const endAll = (kind, subjectId) => q.delAll.run(kind, subjectId);

  return { start, read, end, endAll };
}

// Cookie-authenticated POST/PUT/DELETE must come from our own pages (blocks cross-site form posts).
function sameOrigin(publicUrl) {
  const allowed = new Set();
  if (publicUrl) allowed.add(new URL(publicUrl).origin);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next(); // non-browser clients (curl, tests) send no Origin; cookies still SameSite=Lax
    const self = `${req.protocol}://${req.get('host')}`;
    if (origin === self || allowed.has(origin)) return next();
    res.status(403).json({ error: 'bad_origin' });
  };
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, sha256, randomToken, createSessions, sameOrigin, EMAIL_RE, normEmail, validPassword, parseCookies };
