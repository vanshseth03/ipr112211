import { APP_CONFIG, getBackendUrl, getLastKnownBackendUrl } from '../constants/config';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';

/**
 * Universal Server-Sent Events (SSE) / Real-Time Token Streaming Client
 * Uses fetch + ReadableStream on Web for instant zero-latency token delivery,
 * and XMLHttpRequest with streaming buffers on React Native.
 */
export function createSSEConnection(urlOrPath, options = {}) {
  const isMock = options.mockMode ?? useSettingsStore.getState().mockMode;

  const {
    onOpen,
    onMessage,
    onError,
    onComplete,
    headers = {},
    payload = null,
  } = options;

  let isCancelled = false;

  // Resolve target URL dynamically
  let fullUrl = APP_CONFIG.sseBaseUrl;

  // If no SSE base URL (server not resolved yet), try sync fallback
  if (!fullUrl) {
    const lastUrl = getLastKnownBackendUrl();
    if (lastUrl) {
      fullUrl = `${lastUrl}/api/chat/stream`;
    }
  }

  if (urlOrPath && urlOrPath.startsWith('http')) {
    fullUrl = urlOrPath;
  } else if (urlOrPath && urlOrPath !== '/chat/stream') {
    const apiBase = APP_CONFIG.apiBaseUrl || `${getLastKnownBackendUrl()}/api`;
    fullUrl = `${apiBase}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;
  }

  const token = useAuthStore.getState().accessToken;

  // Combine headers
  const reqHeaders = {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'Bypass-Tunnel-Reminder': 'true',
    'bypass-tunnel-reminder': '1',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  };

  // -------------------------------------------------------------
  // STRATEGY 1: ReadableStream via fetch (Web & Modern Engines)
  // -------------------------------------------------------------
  if (typeof fetch !== 'undefined') {
    const controller = new AbortController();

    (async () => {
      try {
        if (onOpen) onOpen();

        const response = await fetch(fullUrl, {
          method: payload ? 'POST' : 'GET',
          headers: reqHeaders,
          body: payload ? JSON.stringify(payload) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`SSE stream failed with status ${response.status}`);
        }

        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          while (!isCancelled) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            buffer += textChunk;

            // Split into SSE lines
            let boundaryIndex;
            while (
              (boundaryIndex = buffer.indexOf('\n\n')) !== -1 ||
              (boundaryIndex = buffer.indexOf('\r\n\r\n')) !== -1
            ) {
              const isCRLF = buffer.indexOf('\r\n\r\n') === boundaryIndex;
              const boundaryLength = isCRLF ? 4 : 2;

              const eventBlock = buffer.slice(0, boundaryIndex);
              buffer = buffer.slice(boundaryIndex + boundaryLength);

              parseAndEmitSSEBlock(eventBlock, onMessage);
            }
          }

          if (buffer.trim()) {
            parseAndEmitSSEBlock(buffer, onMessage);
          }
          if (onComplete) onComplete();
        } else {
          // Fallback if no reader
          const text = await response.text();
          parseAndEmitSSEBlock(text, onMessage);
          if (onComplete) onComplete();
        }
      } catch (err) {
        if (!isCancelled && err.name !== 'AbortError') {
          console.warn('[SSE fetch error]:', err);
          if (onError) onError(err);
        }
      }
    })();

    return {
      close() {
        isCancelled = true;
        controller.abort();
      },
    };
  }

  // -------------------------------------------------------------
  // STRATEGY 2: XMLHttpRequest Fallback
  // -------------------------------------------------------------
  let xhr = new XMLHttpRequest();
  xhr.open(payload ? 'POST' : 'GET', fullUrl, true);
  Object.keys(reqHeaders).forEach((k) => xhr.setRequestHeader(k, reqHeaders[k]));

  let buffer = '';
  let lastProcessedIndex = 0;

  xhr.onreadystatechange = () => {
    if (isCancelled) return;
    if (xhr.readyState === 2 && xhr.status === 200 && onOpen) onOpen();

    if (xhr.readyState === 3 || xhr.readyState === 4) {
      const responseText = xhr.responseText || '';
      const newChunk = responseText.slice(lastProcessedIndex);
      lastProcessedIndex = responseText.length;

      if (newChunk) {
        buffer += newChunk;
        let boundaryIndex;
        while (
          (boundaryIndex = buffer.indexOf('\n\n')) !== -1 ||
          (boundaryIndex = buffer.indexOf('\r\n\r\n')) !== -1
        ) {
          const isCRLF = buffer.indexOf('\r\n\r\n') === boundaryIndex;
          const boundaryLength = isCRLF ? 4 : 2;
          const eventBlock = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + boundaryLength);
          parseAndEmitSSEBlock(eventBlock, onMessage);
        }
      }
    }

    if (xhr.readyState === 4) {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (buffer.trim()) parseAndEmitSSEBlock(buffer, onMessage);
        if (onComplete) onComplete();
      } else {
        if (onError) onError(new Error(`Stream failed with status ${xhr.status}`));
      }
    }
  };

  xhr.onerror = (err) => {
    if (!isCancelled && onError) onError(err);
  };

  xhr.send(payload ? JSON.stringify(payload) : null);

  return {
    close() {
      isCancelled = true;
      if (xhr) xhr.abort();
    },
  };
}

function parseAndEmitSSEBlock(block, onMessage) {
  if (!block || !onMessage) return;

  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    if (trimmed.startsWith('data:')) {
      const jsonStr = trimmed.slice(5).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        onMessage(parsed);
      } catch {
        onMessage({ token: jsonStr, chunk: jsonStr });
      }
    }
  }
}
