import { APP_CONFIG } from '../constants/config';
import { useAuthStore } from '../store/authStore';

/**
 * Clean Markdown into natural spoken prose.
 * Converts markdown headers, bold/italics, bullet lists, citations,
 * and legal abbreviations into clear, natural spoken text.
 */
export function cleanTextForSpeech(raw) {
  if (!raw) return '';
  return raw
    .replace(/^#+\s*(.+)$/gm, '$1. ') // Markdown headers -> full sentence
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Bold **text** -> text
    .replace(/\*([^*]+)\*/g, '$1') // Italic *text* -> text
    .replace(/__([^_]+)__/g, '$1') // Bold __text__ -> text
    .replace(/_([^_]+)_/g, '$1') // Italic _text_ -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links [text](url) -> text
    .replace(/\[[0-9]+\]/g, '') // Citations [1], [2] -> empty
    .replace(/\[(?:TKDL|Ref|Citation|Vol)[^\]]*\]/gi, '') // Brackets like [TKDL: ...] -> empty
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // Code blocks
    .replace(/^[*\-+]\s+/gm, '') // List bullets
    .replace(/^([0-9]+)\.\s+/gm, 'Point $1: ') // Numbered lists: 1. -> Point 1:
    .replace(/[§]/g, 'Section ') // Symbol § -> Section
    .replace(/\bSec\.\s*/gi, 'Section ') // Sec. -> Section
    .replace(/\be\.g\.,?\s*/gi, 'for example, ') // e.g. -> for example
    .replace(/\bi\.e\.,?\s*/gi, 'that is, ') // i.e. -> that is
    .replace(/\bvs\.\s*/gi, 'versus ') // vs. -> versus
    .replace(/\bw\.r\.t\.\s*/gi, 'with respect to ')
    .replace(/---|\*\*\*|___/g, '') // Dividers
    .replace(/[\r\n]+/g, '. ') // Line breaks -> periods
    .replace(/\.{2,}/g, '.') // Double periods -> single period
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}

/**
 * Split cleaned text into coherent, natural sentences for speech synthesis.
 * Chunks at sentence boundaries (. ! ? or Hindi ।) up to maxChars (350 chars).
 */
export function splitIntoSpokenChunks(cleanText, maxChars = 350) {
  if (!cleanText) return [];
  const sentences = cleanText.split(/(?<=[.!?।])\s+/);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (trimmed.length > maxChars) {
      const clauses = trimmed.split(/(?<=[,;:\-])\s+/);
      for (const clause of clauses) {
        const ct = clause.trim();
        if (!ct) continue;
        if ((current + ' ' + ct).length <= maxChars) {
          current = current ? current + ' ' + ct : ct;
        } else {
          if (current) chunks.push(current.trim());
          current = ct;
        }
      }
    } else if ((current + ' ' + trimmed).length <= maxChars) {
      current = current ? current + ' ' + trimmed : trimmed;
    } else {
      if (current) chunks.push(current.trim());
      current = trimmed;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

let _currentAudio = null;
let _isSpeakingBrowser = false;
let _userCancelled = false;
let _chromeHeartbeatTimer = null;
let _chunkWatchdogTimer = null;

// Global array anchored on window to prevent V8 garbage-collecting in-flight SpeechSynthesisUtterance objects
if (typeof window !== 'undefined') {
  window._activeSpeechUtterances = window._activeSpeechUtterances || [];
}

function startChromeHeartbeat() {
  stopChromeHeartbeat();
  // Call resume() without pause() every 3.5 seconds to keep Chromium speech thread active
  _chromeHeartbeatTimer = setInterval(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }
  }, 3500);
}

function stopChromeHeartbeat() {
  if (_chromeHeartbeatTimer) {
    clearInterval(_chromeHeartbeatTimer);
    _chromeHeartbeatTimer = null;
  }
}

function clearWatchdog() {
  if (_chunkWatchdogTimer) {
    clearTimeout(_chunkWatchdogTimer);
    _chunkWatchdogTimer = null;
  }
}

/**
 * Speak text using high-reliability Browser Native SpeechSynthesis (Web) or fallback.
 */
export async function speakText(text, options = {}) {
  if (!text || !text.trim()) return;

  // Always cancel any previous speech
  stopSpeaking();
  _userCancelled = false;

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return;

  const { onStart, onDone, onStopped, onError, onLoadingStart, onLoadingEnd } = options;

  // In web browsers, native SpeechSynthesis gives instant, zero-latency, full-length playback
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    speakBrowserText(cleaned, options);
    return;
  }

  // Fallback for non-browser / mobile audio player if backend is available
  try {
    if (onLoadingStart) onLoadingStart();
    const isHindi = /[\u0900-\u097F]/.test(cleaned) || options.language === 'hi' || options.language === 'hi-IN';
    const apiLang = isHindi ? 'hi' : 'en';

    const ttsUrl = `${APP_CONFIG.apiBaseUrl}/tts`;
    const token = useAuthStore.getState().accessToken;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

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
        text: cleaned,
        language: apiLang,
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    if (onLoadingEnd) onLoadingEnd();

    const audio = new Audio(audioUrl);
    _currentAudio = audio;

    audio.onplay = () => onStart?.();
    audio.onended = () => {
      _currentAudio = null;
      URL.revokeObjectURL(audioUrl);
      onDone?.();
    };
    audio.onerror = (err) => {
      _currentAudio = null;
      URL.revokeObjectURL(audioUrl);
      onError?.(err);
    };

    await audio.play();
  } catch (err) {
    if (onLoadingEnd) onLoadingEnd();
    onError?.(err);
  }
}

/**
 * Universal sequential sentence-by-sentence SpeechSynthesis for Web.
 * Reads the ENTIRE message completely, across all paragraphs, without cutting off.
 */
function speakBrowserText(cleanText, options = {}) {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    options.onError?.(new Error('Speech synthesis not supported.'));
    return;
  }

  // Cancel any existing utterance
  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();

  const isHindi = /[\u0900-\u097F]/.test(cleanText);
  const targetLang = isHindi ? 'hi-IN' : (options.language || 'en-IN');

  const chunks = splitIntoSpokenChunks(cleanText, 350);
  if (chunks.length === 0) return;

  const voices = window.speechSynthesis.getVoices();
  const selectedVoice = isHindi
    ? voices.find((v) => v.lang.startsWith('hi') || v.name.toLowerCase().includes('hindi'))
    : voices.find((v) => v.lang === 'en-IN' || (v.lang.startsWith('en') && (v.name.includes('India') || v.name.includes('Google') || v.name.includes('Natural'))))
      || voices.find((v) => v.lang.startsWith('en'));

  let currentIndex = 0;
  _isSpeakingBrowser = true;
  _userCancelled = false;

  if (typeof window !== 'undefined') {
    window._activeSpeechUtterances = [];
  }

  startChromeHeartbeat();
  options.onLoadingEnd?.();
  options.onStart?.();

  function speakNext() {
    clearWatchdog();

    if (!_isSpeakingBrowser || _userCancelled) {
      stopSpeaking();
      options.onStopped?.();
      return;
    }

    if (currentIndex >= chunks.length) {
      _isSpeakingBrowser = false;
      stopChromeHeartbeat();
      if (typeof window !== 'undefined') {
        window._activeSpeechUtterances = [];
      }
      options.onDone?.();
      return;
    }

    const chunk = chunks[currentIndex];
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = targetLang;
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = options.rate || 1.0;
    utterance.pitch = options.pitch || 1.0;

    // Anchor utterance to prevent V8 garbage collection
    if (typeof window !== 'undefined') {
      window._activeSpeechUtterances.push(utterance);
    }

    let hasHandledEnd = false;
    const advanceToNext = () => {
      if (hasHandledEnd) return;
      hasHandledEnd = true;
      clearWatchdog();
      currentIndex++;
      speakNext();
    };

    utterance.onend = () => {
      advanceToNext();
    };

    utterance.onerror = (e) => {
      if (_userCancelled || e.error === 'canceled') {
        _isSpeakingBrowser = false;
        stopChromeHeartbeat();
        clearWatchdog();
        options.onStopped?.();
      } else {
        // For non-user interruptions (e.g. browser audio switch), seamlessly advance to next chunk
        console.warn(`[TTS] Chunk ${currentIndex} notice: ${e.error}. Advancing.`);
        advanceToNext();
      }
    };

    // Watchdog timer: If browser drops onend (Chromium bug), auto-advance
    const wordCount = chunk.split(/\s+/).length;
    const expectedDurationMs = Math.max(3000, wordCount * 550 + 3500);
    _chunkWatchdogTimer = setTimeout(() => {
      if (_isSpeakingBrowser && !hasHandledEnd) {
        console.warn(`[TTS] Watchdog advancing stalled chunk ${currentIndex}`);
        advanceToNext();
      }
    }, expectedDurationMs);

    window.speechSynthesis.speak(utterance);
  }

  speakNext();
}

/**
 * Stop speaking immediately.
 */
export function stopSpeaking() {
  _isSpeakingBrowser = false;
  _userCancelled = true;
  stopChromeHeartbeat();
  clearWatchdog();

  if (typeof window !== 'undefined') {
    window._activeSpeechUtterances = [];
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (_) {}
    }
  }

  if (_currentAudio) {
    try {
      _currentAudio.pause();
      _currentAudio.currentTime = 0;
      _currentAudio = null;
    } catch (_) {}
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
