// POST /api/login  { username, password }
//
// Validates credentials server-side against env vars and, on success, issues an
// HttpOnly session cookie. The password hash never leaves the server, so the
// public client bundle no longer contains anything an attacker can crack.

const auth = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  const users         = auth.loadUsers();

  if (!sessionSecret || !users.length) {
    res.status(500).json({ error: 'Server misconfigured: missing SESSION_SECRET, or no accounts in DASHBOARD_USERS / ADMIN_USERNAME+ADMIN_PASSWORD_HASH' });
    return;
  }

  const limit = auth.checkRateLimit(req);
  if (!limit.allowed) {
    res.status(429).json({ error: 'Too many failed attempts. Try again in ' + limit.retryMinutes + ' min.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');

  const match = auth.findUser(users, username);
  // Always run the KDF, even when the username is unknown, so response timing
  // does not reveal whether an account exists.
  const passOk = await auth.verifyPassword(password, match ? match.hash : auth.DUMMY_HASH);

  if (!match || !passOk) {
    auth.recordFailure(req);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  auth.clearFailures(req);
  // Sign the stored spelling, not what was typed, so the session carries a
  // canonical username regardless of how it was capitalised at the prompt.
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.signToken(match.username, sessionSecret)));
  res.status(200).json({ ok: true, username: match.username });
};
