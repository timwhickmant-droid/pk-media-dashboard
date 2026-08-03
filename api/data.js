// Vercel serverless function: proxies dashboard data requests to the Apps
// Script backend, attaching the shared secret server-side. Neither the Apps
// Script exec URL nor the secret ever reach the browser — the client only
// ever calls this same-origin endpoint.
//
// Requires two Vercel environment variables (Project Settings > Environment
// Variables), set to the exec URL and secret configured in the Apps Script
// project's Script Properties:
//   APPS_SCRIPT_URL          e.g. https://script.google.com/macros/s/.../exec
//   DASHBOARD_API_SECRET     a long random string, matching Script Properties' SHARED_SECRET

module.exports = async (req, res) => {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const secret    = process.env.DASHBOARD_API_SECRET;

  if (!scriptUrl || !secret) {
    res.status(500).json({ error: 'Server misconfigured: missing APPS_SCRIPT_URL or DASHBOARD_API_SECRET' });
    return;
  }

  const params = new URLSearchParams(req.query);
  params.set('secret', secret);

  try {
    const upstream = await fetch(scriptUrl + '?' + params.toString());
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(upstream.status).send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed: ' + err.message });
  }
};
