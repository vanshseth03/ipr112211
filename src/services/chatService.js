import {
  sendChatMessage,
  getChatHistory,
  getChatStreamUrl,
} from '../api/endpoints/chat';
import { createSSEConnection } from '../api/sse';

export async function sendMessage(message, options = {}) {
  return sendChatMessage({
    query: message,
    message,
    ...options,
  });
}

export function streamChatMessage(message, options = {}) {
  const { onToken, onSources, onComplete, onError, messages, history, ...rest } = options;
  const payload = {
    query: message,
    message,
    top_k: 5,
    messages: messages || history || [],
    ...rest,
  };

  return createSSEConnection('/chat/stream', {
    payload,
    onMessage: (msg) => {
      if (msg.type === 'sources' && onSources) {
        onSources(msg.sources || []);
      } else if (msg.type === 'token' && onToken) {
        onToken(msg.token || '');
      } else if (msg.chunk && onToken) {
        onToken(msg.chunk);
      } else if (msg.type === 'done' && onComplete) {
        onComplete();
      }
    },
    onComplete: () => {
      if (onComplete) onComplete();
    },
    onError: (err) => {
      if (onError) onError(err);
    },
  });
}

export async function loadChatHistory() {
  return getChatHistory();
}

export function getStreamUrl() {
  return getChatStreamUrl();
}
