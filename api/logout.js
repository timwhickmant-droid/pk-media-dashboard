// POST /api/logout — clears the session cookie.

const auth = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookie());
  res.status(200).json({ ok: true });
};
