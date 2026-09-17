const fs = require('fs');
const path = require('path');
const {
  setCors,
  getKaggleStatus,
  saveKaggleKernel,
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
    // 1. Dual-Session Guard: Is a Kaggle kernel already running or queued?
    const kaggleState = await getKaggleStatus();
    const kaggleStatus = kaggleState.status || '';

    if (['RUNNING', 'QUEUED', 'STARTING'].includes(kaggleStatus)) {
      return res.status(200).json({
        triggered: false,
        already_running: true,
        kaggle_status: kaggleStatus,
        message: `Kaggle worker is already ${kaggleStatus}. Dual session prevented.`,
      });
    }

    // 2. Check if active server URL in Gist is already healthy
    const gist = await readGistRegistry();
    if (gist?.server_url && gist?.status === 'running') {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const hResp = await fetch(`${gist.server_url}/api/health`, {
          signal: ctrl.signal,
          headers: { 'Bypass-Tunnel-Reminder': 'true' },
        });
        clearTimeout(timer);
        if (hResp.ok) {
          const hData = await hResp.json();
          if (hData.ready) {
            return res.status(200).json({
              triggered: false,
              already_running: true,
              server_url: gist.server_url,
              message: 'Server is already online and healthy. Dual session prevented.',
            });
          }
        }
      } catch (_) {}
    }

    // 3. Read server code
    const serverPyPath = path.join(__dirname, 'server.py');
    if (!fs.existsSync(serverPyPath)) {
      return res.status(500).json({
        error: 'server.py not found in api/server directory',
      });
    }
    const scriptText = fs.readFileSync(serverPyPath, 'utf-8');

    // 4. Push kernel to Kaggle
    const pushResult = await saveKaggleKernel(scriptText);

    // 5. Update Gist registry to booting status
    const now = new Date().toISOString();
    await updateGistRegistry({
      server_url: '',
      status: 'booting',
      started_at: now,
      last_heartbeat: now,
      kaggle_kernel: `${KAGGLE_USERNAME}/${KERNEL_SLUG}`,
    });

    return res.status(200).json({
      triggered: true,
      message: 'Kaggle GPU kernel push successfully triggered! Booting Dual Tesla T4 server.',
      push_result: pushResult,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to start Kaggle server',
      details: err.message,
    });
  }
};
