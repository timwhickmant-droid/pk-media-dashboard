// GET /api/session — reports whether the caller holds a valid session.
// The page calls this on load to decide between the dashboard and the login
// screen, so that decision is made by the server rather than by localStorage.

const auth = require('./_auth');

module.exports = async (req, res) => {
  const session = auth.getSession(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.status(200).json({ authenticated: true, username: session.u, expiresAt: session.exp * 1000 });
};
