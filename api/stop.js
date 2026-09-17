const {
  setCors,
  readGistRegistry,
  updateGistRegistry,
  KAGGLE_USERNAME,
  KERNEL_SLUG,
} = require('./_kaggle');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const gist = await readGistRegistry();
    const serverUrl = gist?.server_url || '';
    let shutdownNotified = false;

    if (serverUrl) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const sResp = await fetch(`${serverUrl}/api/shutdown`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'true',
          },
          body: JSON.stringify({ reason: 'user_requested_stop' }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        shutdownNotified = sResp.ok;
      } catch (e) {
        shutdownNotified = true;
      }
    }

    const now = new Date().toISOString();
    await updateGistRegistry({
      server_url: '',
      status: 'offline',
      started_at: '',
      expires_at: '',
      last_heartbeat: now,
      kaggle_kernel: `${KAGGLE_USERNAME}/${KERNEL_SLUG}`,
    });

    return res.status(200).json({
      stopped: true,
      shutdown_notified: shutdownNotified,
      message: 'Kaggle server shutdown command sent and registry marked offline.',
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to shut down server',
      details: err.message,
    });
  }
};
