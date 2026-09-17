import { APP_CONFIG } from '../constants/config';
import { useAuthStore } from '../store/authStore';

/**
 * Clean Markdown into natural spoken prose.
 * Expands legal citations, symbols, and abbreviations so speech engines pronounce them smoothly.
 */
export function cleanTextForSpeech(raw) {
  if (!raw) return '';
  return raw
    .replace(/^#+\s+/gm, '') // Remove markdown headers #, ##, ###
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Bold **text** -> text
    .replace(/\*([^*]+)\*/g, '$1') // Italic *text* -> text
    .replace(/__([^_]+)__/g, '$1') // Bold __text__ -> text
    .replace(/_([^_]+)_/g, '$1') // Italic _text_ -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links [text](url) -> text
    .replace(/\[[0-9]+\]/g, '') // Citations [1], [2] -> empty
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // Code blocks
    .replace(/^[*\-+]\s+/gm, '') // List bullets
    .replace(/^([0-9]+)\.\s+/gm, 'Point $1: ') // Numbered lists: 1. -> Point 1:
    .replace(/[§]/g, 'Section ') // Symbol § -> Section
    .replace(/\bSec\.\s*/gi, 'Section ') // Sec. -> Section
    .replace(/\be\.g\.,?\s*/gi, 'for example, ') // e.g. -> for example
    .replace(/\bi\.e\.,?\s*/gi, 'that is, ') // i.e. -> that is
    .replace(/\bvs\.\s*/gi, 'versus ') // vs. -> versus
    .replace(/[\r\n]+/g, '. ') // Line breaks -> periods
    .replace(/\.{2,}/g, '.') // Double periods -> single period
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}

let _currentAudio = null;
let _isSpeakingBrowser = false;
// Global set to retain active utterances and prevent Chromium GC bug
const _activeUtterancePool = new Set();
let _chromeHeartbeatTimer = null;

function startChromeHeartbeat() {
  stopChromeHeartbeat();
  _chromeHeartbeatTimer = setInterval(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
  }, 10000);
}

function stopChromeHeartbeat() {
  if (_chromeHeartbeatTimer) {
    clearInterval(_chromeHeartbeatTimer);
    _chromeHeartbeatTimer = null;
  }
}

/**
 * Speak text using Browser Native SpeechSynthesis (Web) or Audio Player.
 * @param {string} text - Text to speak
 * @param {Object} options - { language, rate, pitch, onStart, onDone, onStopped, onError, onLoadingStart, onLoadingEnd }
 */
export async function speakText(text, options = {}) {
  if (!text || !text.trim()) return;

  // Always stop previous speech before starting
  stopSpeaking();

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return;

  const { onStart, onDone, onStopped, onError, onLoadingStart, onLoadingEnd } = options;

  // Detect Hindi: check for Devanagari Unicode characters or explicit Hindi option
  const isHindi = /[\u0900-\u097F]/.test(cleaned) || options.language === 'hi' || options.language === 'hi-IN';
  const apiLang = isHindi ? 'hi' : 'en';

  if (onLoadingStart) onLoadingStart();

  // 1. Try OmniVoice Neural TTS if available
  try {
    const ttsUrl = `${APP_CONFIG.apiBaseUrl}/tts`;
    const token = useAuthStore.getState().accessToken;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // Fast 4s timeout for fallback

    const response = await fetch(ttsUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Bypass-Tunnel-Reminder': 'true',
        'bypass-tunnel-reminder': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        text: cleaned.substring(0, 1000),
        language: apiLang,
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`OmniVoice server returned HTTP ${response.status}`);
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    if (onLoadingEnd) onLoadingEnd();

    const audio = new Audio(audioUrl);
    _currentAudio = audio;

    audio.onplay = () => {
      if (onStart) onStart();
    };

    audio.onended = () => {
      _currentAudio = null;
      URL.revokeObjectURL(audioUrl);
      if (onDone) onDone();
    };

    audio.onerror = (err) => {
      _currentAudio = null;
      URL.revokeObjectURL(audioUrl);
      if (onError) onError(err);
    };

    await audio.play();
    return; // Successfully played OmniVoice audio
  } catch (backendErr) {
    if (onLoadingEnd) onLoadingEnd();

    // 2. High-reliability Browser native SpeechSynthesis
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      speakBrowserText(cleaned, options);
      return;
    }

    if (onError) onError(backendErr);
  }
}

/**
 * Universal chunked SpeechSynthesis for Web
 * Fixes Chromium garbage-collection defect and long-utterance freeze bug.
 */
function speakBrowserText(cleanText, options = {}) {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    options.onError?.(new Error('Speech synthesis not available in this browser.'));
    return;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();

  // Detect Devanagari characters
  const isHindi = /[\u0900-\u097F]/.test(cleanText);
  const targetLang = isHindi ? 'hi-IN' : (options.language || 'en-IN');

  // Split text by punctuation marks that are followed by a space or end of string
  // Prevents splitting within numbers like 3.5 or legal terms like 3(p)
  const rawSegments = cleanText.split(/(?<=[.!?।])\s+/);
  const chunks = [];
  let current = '';

  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    if (trimmed.length > 200) {
      // Long clause: split further at commas or semicolons
      const subParts = trimmed.split(/(?<=[,;])\s+/);
      for (const sp of subParts) {
        if ((current + ' ' + sp).length <= 200) {
          current = current ? current + ' ' + sp : sp;
        } else {
          if (current) chunks.push(current);
          current = sp;
        }
      }
    } else if ((current + ' ' + trimmed).length <= 200) {
      current = current ? current + ' ' + trimmed : trimmed;
    } else {
      if (current) chunks.push(current);
      current = trimmed;
    }
  }
  if (current) chunks.push(current);

  if (chunks.length === 0) return;

  const voices = window.speechSynthesis.getVoices();
  const selectedVoice = isHindi
    ? voices.find((v) => v.lang.startsWith('hi') || v.name.toLowerCase().includes('hindi'))
    : voices.find((v) => v.lang === 'en-IN' || (v.lang.startsWith('en') && !v.name.includes('David')));

  let currentIndex = 0;
  _isSpeakingBrowser = true;
  _activeUtterancePool.clear();
  startChromeHeartbeat();
  options.onStart?.();

  function speakNext() {
    if (!_isSpeakingBrowser) {
      stopChromeHeartbeat();
      _activeUtterancePool.clear();
      return;
    }

    if (currentIndex >= chunks.length) {
      _isSpeakingBrowser = false;
      stopChromeHeartbeat();
      _activeUtterancePool.clear();
      options.onDone?.();
      return;
    }

    const chunk = chunks[currentIndex];
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = targetLang;
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = options.rate || 1.0;
    utterance.pitch = options.pitch || 1.0;

    // CRITICAL: Prevent garbage collection in Chrome/Edge V8
    _activeUtterancePool.add(utterance);

    utterance.onend = () => {
      _activeUtterancePool.delete(utterance);
      currentIndex++;
      speakNext();
    };

    utterance.onerror = (e) => {
      _activeUtterancePool.delete(utterance);
      if (e.error === 'interrupted' || e.error === 'canceled') {
        _isSpeakingBrowser = false;
        stopChromeHeartbeat();
        options.onStopped?.();
      } else {
        console.warn('[TTS] Utterance error:', e);
        // Continue to next chunk even if an individual utterance errored
        currentIndex++;
        speakNext();
      }
    };

    window.speechSynthesis.speak(utterance);
  }

  speakNext();
}

/**
 * Stop speaking immediately.
 */
export function stopSpeaking() {
  _isSpeakingBrowser = false;
  stopChromeHeartbeat();
  _activeUtterancePool.clear();

  if (_currentAudio) {
    try {
      _currentAudio.pause();
      _currentAudio.currentTime = 0;
      _currentAudio = null;
    } catch (err) {
      console.warn('[TTS] Audio pause error:', err);
    }
  }

  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch (err) {
      console.warn('[TTS] Synthesis cancel error:', err);
    }
  }
}

/**
 * Check if currently speaking.
 */
export function isSpeaking() {
  if (_currentAudio && !_currentAudio.paused && !_currentAudio.ended) {
    return true;
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    return window.speechSynthesis.speaking || _isSpeakingBrowser;
  }
  return false;
}
