// Shared server-side auth helpers for the dashboard's API routes.
//
// Files prefixed with "_" are not routed as endpoints by Vercel, so this is a
// plain shared module. Uses only Node builtins — no dependencies to install.
//
// Session model: a stateless HMAC-signed token carried in an HttpOnly cookie.
// Because it is HttpOnly, page JavaScript cannot read it, so an XSS bug cannot
// exfiltrate the session. Because it is signed with a server-only secret, a
// client cannot forge or extend one.

const crypto = require('crypto');

const COOKIE_NAME     = 'pk_session';
const SESSION_SECONDS = 8 * 60 * 60; // 8h, matching the UI's stated session length

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// Constant-time compare that tolerates differing lengths without throwing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function signToken(username, secret) {
  const payload = JSON.stringify({
    u: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  });
  const body = b64url(payload);
  const sig  = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

// Returns the payload object, or null if missing/tampered/expired.
function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const expectedSig = b64url(crypto.createHmac('sha256', secret).update(parts[0]).digest());
  if (!safeEqual(parts[1], expectedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i < 0) return;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(token) {
  // Secure + HttpOnly + SameSite=Strict: not readable by JS, not sent
  // cross-site, only over HTTPS.
  //
  // Deliberately no Max-Age/Expires — that makes this a browser-session
  // cookie, discarded when the browser closes, so visiting the site again
  // requires signing in. SESSION_SECONDS still caps it inside the signed
  // token, so a browser left open for days cannot hold a session forever.
  return COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; HttpOnly; Secure; SameSite=Strict; Path=/';
}

function clearCookie() {
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
}

// Reads and validates the session on an incoming request.
function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return verifyToken(parseCookies(req)[COOKIE_NAME], secret);
}

// Builds the account list from environment variables.
//
// Two sources, merged:
//   DASHBOARD_USERS  JSON array: [{"username":"Gina","hash":"scrypt:..."}]
//   ADMIN_USERNAME + ADMIN_PASSWORD_HASH   the original single-account pair
//
// Keeping both means adding accounts never requires re-hashing the existing
// admin password, and a half-finished migration cannot lock everyone out.
function loadUsers() {
  const users = [];

  const raw = process.env.DASHBOARD_USERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach(function (u) {
          if (u && u.username && u.hash) {
            users.push({ username: String(u.username), hash: String(u.hash) });
          }
        });
      }
    } catch (e) {
      // Malformed JSON must not silently drop every account defined here, but
      // it also must not throw — fall through to the admin pair below.
    }
  }

  const adminUser = process.env.ADMIN_USERNAME;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;
  if (adminUser && adminHash) {
    const dup = users.some(function (u) {
      return u.username.toLowerCase() === adminUser.toLowerCase();
    });
    // DASHBOARD_USERS wins on conflict, so an account can be overridden there.
    if (!dup) users.push({ username: adminUser, hash: adminHash });
  }

  return users;
}

function findUser(users, username) {
  const wanted = String(username || '').trim().toLowerCase();
  return users.find(function (u) { return u.username.toLowerCase() === wanted; }) || null;
}

// A syntactically valid hash that no password matches. Verifying against this
// when the username is unknown keeps the response time comparable to a real
// lookup, so timing does not reveal which accounts exist.
const DUMMY_HASH = 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128);

// Verifies a password against a stored "scrypt:<saltHex>:<hashHex>" string.
// scrypt is a deliberately slow KDF, so a leaked hash is far more expensive to
// crack than the plain SHA-256 this replaced.
function verifyPassword(password, stored) {
  return new Promise(function (resolve) {
    if (!stored || typeof stored !== 'string') return resolve(false);
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);

    const salt     = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');

    crypto.scrypt(String(password), salt, expected.length, function (err, derived) {
      if (err) return resolve(false);
      resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
    });
  });
}

// Best-effort brute-force throttle. Serverless instances are ephemeral and
// there may be several in parallel, so this adds friction rather than a hard
// guarantee — it is a backstop behind the password, not the primary defense.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS    = 15 * 60 * 1000;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim() || 'unknown';
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) return { allowed: true };
  if (rec.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryMinutes: Math.ceil((rec.resetAt - now) / 60000) };
  }
  return { allowed: true };
}

function recordFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count++;
  }
}

function clearFailures(req) {
  attempts.delete(clientIp(req));
}

module.exports = {
  COOKIE_NAME, SESSION_SECONDS,
  signToken, verifyToken, getSession,
  sessionCookie, clearCookie,
  verifyPassword, safeEqual,
  loadUsers, findUser, DUMMY_HASH,
  checkRateLimit, recordFailure, clearFailures
};
