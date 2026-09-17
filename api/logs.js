const {
  setCors,
  getKaggleLogs,
  getKaggleStatus,
} = require('./_kaggle');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const [logData, statusData] = await Promise.all([
      getKaggleLogs(),
      getKaggleStatus(),
    ]);

    return res.status(200).json({
      kaggle_status: statusData.status || 'UNKNOWN',
      logs: logData.logs || [],
      count: logData.logs?.length || 0,
      error: logData.error || null,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to fetch logs',
      details: err.message,
    });
  }
};
