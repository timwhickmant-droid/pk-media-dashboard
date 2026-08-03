// GET /api/data — authenticated proxy to the Apps Script backend.
//
// Two things happen here:
//  1. The request is rejected unless it carries a valid session cookie, so the
//     dashboard's data is genuinely behind the login rather than merely hidden
//     by client-side UI.
//  2. The Apps Script URL and its shared secret are attached server-side, so
//     neither ever reaches the browser or the public repo.
//
// Required Vercel environment variables:
//   APPS_SCRIPT_URL        the Apps Script /exec URL
//   DASHBOARD_API_SECRET   matches SHARED_SECRET in the script's Script Properties
//   SESSION_SECRET         used to verify the session cookie signature

const auth = require('./_auth');

module.exports = async (req, res) => {
  if (!auth.getSession(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const secret    = process.env.DASHBOARD_API_SECRET;

  if (!scriptUrl || !secret) {
    res.status(500).json({ error: 'Server misconfigured: missing APPS_SCRIPT_URL or DASHBOARD_API_SECRET' });
    return;
  }

  // Build the upstream query from the client's params, but never let the client
  // supply its own "secret" — it is always overwritten with the server's.
  const params = new URLSearchParams(req.query);
  params.delete('secret');
  params.set('secret', secret);

  try {
    const upstream = await fetch(scriptUrl + '?' + params.toString());
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    // Responses are per-user and private; keep them out of shared caches.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(upstream.status).send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed: ' + err.message });
  }
};
