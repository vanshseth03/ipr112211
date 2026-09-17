const fs = require('fs');
const path = require('path');
const os = require('os');

const GIST_ID = '7873aa6da8f97b2b817137dd4f2df5be';
const GIST_FILENAME = 'server_registry.json';
const KAGGLE_USERNAME = process.env.KAGGLE_USERNAME || 'vanshseth003';
const DEFAULT_KAGGLE_KEY = '75c22236a6ebde0410820d13b3b77088';
const KERNEL_SLUG = 'ayush-ipr-guardian';

function getKaggleCredentials() {
  const username = process.env.KAGGLE_USERNAME || KAGGLE_USERNAME;
  let key = process.env.KAGGLE_KEY || '';

  if (!key) {
    try {
      const kagglePath = path.join(os.homedir(), '.kaggle', 'kaggle.json');
      if (fs.existsSync(kagglePath)) {
        const raw = fs.readFileSync(kagglePath, 'utf-8');
        const parsed = JSON.parse(raw);
        key = parsed.key || '';
      }
    } catch (_) {}
  }

  if (!key) {
    key = DEFAULT_KAGGLE_KEY;
  }

  return { username, key };
}

function getGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.EXPO_PUBLIC_GITHUB_TOKEN || '';
}

function getAuthHeader(username, key) {
  return 'Basic ' + Buffer.from(`${username}:${key}`).toString('base64');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Bypass-Tunnel-Reminder');
}

async function getKaggleStatus() {
  const { username, key } = getKaggleCredentials();
  if (!key) {
    return { error: 'KAGGLE_KEY not configured', status: 'UNKNOWN' };
  }

  const url = 'https://api.kaggle.com/v1/kernels.KernelsApiService/GetKernelSessionStatus';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(username, key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userName: username,
        kernelSlug: KERNEL_SLUG,
      }),
    });

    if (!response.ok) {
      return { status: 'UNKNOWN', error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return {
      status: data.status || 'UNKNOWN',
      failureMessage: data.failureMessage || null,
    };
  } catch (err) {
    return { status: 'UNKNOWN', error: err.message };
  }
}

async function getKaggleLogs() {
  const { username, key } = getKaggleCredentials();
  if (!key) {
    return { error: 'KAGGLE_KEY not configured', logs: [] };
  }

  const url = 'https://api.kaggle.com/v1/kernels.KernelsApiService/ListKernelSessionOutput';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(username, key),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userName: username,
        kernelSlug: KERNEL_SLUG,
      }),
    });

    if (!response.ok) {
      return { logs: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const rawLog = data.log || '';
    const rawLines = rawLog.split('\n');
    const logs = [];

    for (const line of rawLines) {
      const trimmed = line.trim().replace(/^,/, '');
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed);
        if (item.data) {
          logs.push({
            time: item.time || 0,
            text: item.data.replace(/\n$/, ''),
            stream: item.stream_name || 'stdout',
          });
        }
      } catch (_) {
        logs.push({ time: 0, text: trimmed, stream: 'stdout' });
      }
    }

    return { logs, rawLength: rawLog.length };
  } catch (err) {
    return { logs: [], error: err.message };
  }
}

async function saveKaggleKernel(scriptText) {
  const { username, key } = getKaggleCredentials();
  if (!key) {
    throw new Error('KAGGLE_KEY not configured');
  }

  const url = 'https://api.kaggle.com/v1/kernels.KernelsApiService/SaveKernel';
  const payload = {
    slug: `${username}/${KERNEL_SLUG}`,
    newTitle: KERNEL_SLUG,
    text: scriptText,
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: true,
    enableInternet: true,
    datasetDataSources: [`${username}/ayush-ipr-rag-database`],
    modelDataSources: ['google/gemma-2/transformers/gemma-2-2b-it/1'],
    machineShape: 'NvidiaTeslaT4',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(username, key),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kaggle push failed (HTTP ${response.status}): ${errText}`);
  }

  return await response.json();
}

async function readGistRegistry() {
  const token = getGithubToken();
  const headers = { 'User-Agent': 'AYUSH-IPR-Guardian' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers,
      cache: 'no-cache',
    });
    if (res.ok) {
      const gist = await res.json();
      const content = gist?.files?.[GIST_FILENAME]?.content;
      return content ? JSON.parse(content) : null;
    }
  } catch (_) {}

  // Fallback to raw URL (never rate-limited)
  try {
    const rawRes = await fetch(
      `https://gist.githubusercontent.com/vanshseth03/${GIST_ID}/raw/${GIST_FILENAME}?t=${Date.now()}`,
      { cache: 'no-cache' }
    );
    if (rawRes.ok) return await rawRes.json();
  } catch (_) {}

  return null;
}

async function updateGistRegistry(data) {
  const token = getGithubToken();
  if (!token) return false;

  try {
    const payload = JSON.stringify({
      files: {
        [GIST_FILENAME]: {
          content: JSON.stringify(data, null, 2),
        },
      },
    });

    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'AYUSH-IPR-Guardian',
      },
      body: payload,
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

module.exports = {
  GIST_ID,
  GIST_FILENAME,
  KAGGLE_USERNAME,
  KERNEL_SLUG,
  getKaggleCredentials,
  getGithubToken,
  setCors,
  getKaggleStatus,
  getKaggleLogs,
  saveKaggleKernel,
  readGistRegistry,
  updateGistRegistry,
};
