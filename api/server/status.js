const {
  setCors,
  getKaggleStatus,
  readGistRegistry,
} = require('./_kaggle');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const [kaggleState, gistRegistry] = await Promise.all([
      getKaggleStatus(),
      readGistRegistry(),
    ]);

    const kaggleStatus = kaggleState.status || 'UNKNOWN';
    let serverUrl = gistRegistry?.server_url || '';
    let status = 'offline';
    let ready = false;
    let healthData = null;

    // Is Kaggle currently active or booting?
    const isKaggleActive = ['RUNNING', 'QUEUED', 'STARTING'].includes(kaggleStatus);

    if (serverUrl) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const healthResp = await fetch(`${serverUrl}/api/health`, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'AYUSH-IPR-Guardian',
            'Bypass-Tunnel-Reminder': 'true',
            'bypass-tunnel-reminder': '1',
          },
        });
        clearTimeout(timer);

        if (healthResp.ok) {
          healthData = await healthResp.json();
          ready = !!healthData.ready;
          status = ready ? 'running' : 'booting';
        } else {
          status = isKaggleActive ? 'booting' : 'offline';
        }
      } catch (_) {
        status = isKaggleActive ? 'booting' : 'offline';
      }
    } else if (isKaggleActive || gistRegistry?.status === 'booting') {
      status = 'booting';
    }

    return res.status(200).json({
      status, // 'running' | 'booting' | 'offline'
      ready,
      server_url: serverUrl,
      kaggle_status: kaggleStatus,
      kaggle_active: isKaggleActive,
      health: healthData,
      last_heartbeat: gistRegistry?.last_heartbeat || null,
      started_at: gistRegistry?.started_at || null,
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
};
