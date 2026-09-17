import { APP_CONFIG } from '../constants/config';

/**
 * Voice service — creates a voice session by calling the real API endpoints.
 * The actual voice loop logic is in useVoiceSession hook.
 * This file is kept for backward compatibility but the WebSocket approach is removed.
 */

export function getApiBaseUrl() {
  return APP_CONFIG.apiBaseUrl;
}
