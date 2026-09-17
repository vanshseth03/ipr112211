import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_STATES } from '../models/voice';
import { APP_CONFIG } from '../constants/config';
import { useAuthStore } from '../store/authStore';

/**
 * useVoiceSession — Real voice call flow:
 *   1. Record mic audio via MediaRecorder (browser Web Audio API)
 *   2. POST recorded blob to /api/transcribe (Whisper ASR on Kaggle)
 *   3. POST transcribed text to /api/chat (Gemma 2B RAG)
 *   4. POST answer text to /api/tts (OmniVoice on Kaggle)
 *   5. Play returned WAV audio
 *   6. Loop back to step 1 (continuous conversation)
 */
export function useVoiceSession() {
  const [status, setStatus] = useState(VOICE_STATES.IDLE);
  const [transcript, setTranscript] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [error, setError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const isActiveRef = useRef(false);
  const audioRef = useRef(null);

  const getHeaders = () => {
    const token = useAuthStore.getState().accessToken;
    return {
      'Bypass-Tunnel-Reminder': 'true',
      'bypass-tunnel-reminder': '1',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  // ── Step 1: Start recording mic audio ──
  const startRecording = useCallback(async () => {
    try {
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // When recording stops, process the captured audio
        if (isActiveRef.current && chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          processAudio(blob);
        }
      };

      recorder.start();
      setStatus(VOICE_STATES.LISTENING);
    } catch (err) {
      console.error('[Voice] Mic access denied:', err);
      setError(err);
      setStatus(VOICE_STATES.ERROR);
    }
  }, []);

  // ── Stop recording (triggers onstop → processAudio) ──
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // ── Step 2: Transcribe audio via Whisper ASR ──
  const processAudio = async (audioBlob) => {
    if (!isActiveRef.current) return;
    setStatus(VOICE_STATES.PROCESSING);
    setTranscript('Transcribing...');

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const transcribeRes = await fetch(`${APP_CONFIG.apiBaseUrl}/transcribe`, {
        method: 'POST',
        headers: getHeaders(),
        body: formData,
      });

      if (!transcribeRes.ok) throw new Error(`ASR failed: ${transcribeRes.status}`);

      const transcribeData = await transcribeRes.json();
      const userText = transcribeData.text?.trim();

      if (!userText || userText.length < 2) {
        // No speech detected, go back to listening
        setTranscript('(no speech detected)');
        if (isActiveRef.current) {
          setTimeout(() => startRecording(), 500);
        }
        return;
      }

      setTranscript(userText);

      // ── Step 3 & 4: Continuous Streaming Talkback (Pipelined ~20-word chunk generation + OmniVoice TTS) ──
      await processStreamingTalkback(userText, transcribeData.language);
    } catch (err) {
      console.error('[Voice] Transcription error:', err);
      setError(err);
      // Continue listening even on error
      if (isActiveRef.current) {
        setTimeout(() => startRecording(), 1000);
      }
    }
  };

  // ── Step 3 & 4: Continuous Streaming Talkback ──
  const processStreamingTalkback = async (userText, detectedLanguage) => {
    if (!isActiveRef.current) return;
    setStatus(VOICE_STATES.CONNECTED);
    setAiResponse('Thinking...');

    const token = useAuthStore.getState().accessToken;
    const isHindi = /[\u0900-\u097F]/.test(userText) || detectedLanguage === 'hi' || detectedLanguage === 'hi-IN';
    const targetLang = isHindi ? 'hi' : 'en';

    // Queue of { blob, text }
    const audioQueue = [];
    let isPlaying = false;
    let streamFinished = false;

    const playNext = () => {
      if (!isActiveRef.current) return;
      if (isPlaying) return;

      if (audioQueue.length === 0) {
        if (streamFinished) {
          // Entire talkback finished!
          setTimeout(() => {
            if (isActiveRef.current) {
              startRecording(); // Loop back to listening for next turn
            }
          }, 300);
        }
        return;
      }

      const item = audioQueue.shift();
      const audioUrl = URL.createObjectURL(item.blob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      isPlaying = true;

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
        isPlaying = false;
        playNext();
      };

      audio.onerror = (e) => {
        console.warn('[Talkback] Audio chunk playback error:', e);
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
        isPlaying = false;
        playNext();
      };

      audio.play().catch((playErr) => {
        console.warn('[Talkback] play() error:', playErr);
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
        isPlaying = false;
        playNext();
      });
    };

    const synthesizeChunk = async (chunkText) => {
      if (!isActiveRef.current || !chunkText.trim()) return;
      try {
        const ttsRes = await fetch(`${APP_CONFIG.apiBaseUrl}/tts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'true',
            'bypass-tunnel-reminder': '1',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            text: chunkText.trim(),
            language: targetLang,
          }),
        });

        if (ttsRes.ok) {
          const blob = await ttsRes.blob();
          audioQueue.push({ blob, text: chunkText });
          playNext();
        } else {
          console.warn(`[Talkback] TTS chunk HTTP ${ttsRes.status}`);
        }
      } catch (err) {
        console.warn('[Talkback] TTS chunk error:', err.message);
      }
    };

    try {
      const sseRes = await fetch(`${APP_CONFIG.apiBaseUrl}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Bypass-Tunnel-Reminder': 'true',
          'bypass-tunnel-reminder': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          query: userText,
          language: targetLang,
        }),
      });

      if (!sseRes.ok) throw new Error(`Chat stream failed: ${sseRes.status}`);

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let accumulatedResponse = '';
      let chunkBuffer = '';
      let sseBuffer = '';

      while (isActiveRef.current) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop(); // keep partial line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);
            if (data.type === 'token' && data.token) {
              accumulatedResponse += data.token;
              chunkBuffer += data.token;
              setAiResponse(accumulatedResponse);

              // Check if chunk has ~18-20 words AND hits a natural sentence end or pause
              const words = chunkBuffer.trim().split(/\s+/);
              const hasSentenceBoundary = /[.!?।\n]/.test(data.token);

              if ((words.length >= 18 && hasSentenceBoundary) || words.length >= 26) {
                const chunkToSpeak = chunkBuffer.trim();
                chunkBuffer = '';
                synthesizeChunk(chunkToSpeak);
              }
            } else if (data.type === 'done') {
              break;
            }
          } catch (pe) {
            // ignore non-json SSE lines
          }
        }
      }

      // Synthesize any remaining text
      if (chunkBuffer.trim()) {
        await synthesizeChunk(chunkBuffer.trim());
      }

      streamFinished = true;
      playNext();
    } catch (streamErr) {
      console.warn('[Talkback] Stream failed, falling back to non-streaming chat:', streamErr.message);
      try {
        const chatRes = await fetch(`${APP_CONFIG.apiBaseUrl}/chat`, {
          method: 'POST',
          headers: { ...getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userText }),
        });
        if (chatRes.ok) {
          const chatData = await chatRes.json();
          const ans = chatData.answer || 'Response completed.';
          setAiResponse(ans);
          await synthesizeChunk(ans.substring(0, 300));
          streamFinished = true;
          playNext();
        }
      } catch (fallbackErr) {
        console.error('[Talkback] Fallback also failed:', fallbackErr);
        if (isActiveRef.current) setTimeout(() => startRecording(), 1000);
      }
    }
  };

  const _browserTTSFallback = (text) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      if (isActiveRef.current) startRecording();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.substring(0, 300));
    utterance.lang = 'en-IN';
    utterance.rate = 1.0;
    utterance.onend = () => {
      if (isActiveRef.current) startRecording();
    };
    utterance.onerror = () => {
      if (isActiveRef.current) startRecording();
    };
    window.speechSynthesis.speak(utterance);
  };

  // ── Connect: start the voice session loop ──
  const connect = useCallback(() => {
    setError(null);
    setTranscript('');
    setAiResponse('');
    isActiveRef.current = true;
    setStatus(VOICE_STATES.CONNECTING);
    setTimeout(() => {
      if (isActiveRef.current) startRecording();
    }, 300);
  }, [startRecording]);

  // ── Disconnect: tear down everything ──
  const disconnect = useCallback(() => {
    isActiveRef.current = false;

    // Stop recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    mediaRecorderRef.current = null;

    // Release mic
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    // Stop any playing audio
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current = null;
      } catch {}
    }

    // Stop browser TTS
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    setStatus(VOICE_STATES.IDLE);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      disconnect();
    };
  }, [disconnect]);

  return {
    status,
    transcript,
    aiResponse,
    isConnected: status !== VOICE_STATES.IDLE && status !== VOICE_STATES.ERROR,
    isListening: status === VOICE_STATES.LISTENING,
    isProcessing: status === VOICE_STATES.PROCESSING,
    error,
    connect,
    disconnect,
    stopRecording,
  };
}
