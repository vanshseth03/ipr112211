import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import { useState, useRef } from 'react';
import {
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Camera,
  Mic,
  Paperclip,
  Square,
  X,
  Trash2,
} from 'lucide-react-native';

import FileCard from '../upload/FileCard';
import { createFileModel } from '../../models/files';
import { APP_CONFIG, t } from '../../constants/config';
import { useAuthStore } from '../../store/authStore';
import { colors, radii, spacing, shadow } from '../../constants/theme';

// Max file size 10MB
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export default function InputBar({
  onSend,
  onPickDocument,
  onPickImage,
  onCameraCapture,
  onFileSelected,
  onStopStreaming,
  attachedFile,
  onRemoveAttachment,
  disabled = false,
  isStreaming = false,
  language = 'en',
  placeholder = 'Ask about Ayurveda IPR, Section 3(p), TKDL...',
}) {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerIntervalRef = useRef(null);

  // Hidden native web file inputs for 100% reliable browser clicks
  const webDocInputRef = useRef(null);
  const webImgInputRef = useRef(null);
  const webCamInputRef = useRef(null);

  const trimmedText = text.trim();
  const hasText = trimmedText.length > 0;
  const canSend = !disabled && !isStreaming && !isRecording && !isTranscribing && (hasText || !!attachedFile);

  const handleSend = () => {
    if (!canSend) return;
    onSend?.(trimmedText);
    setText('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleStop = () => {
    onStopStreaming?.();
  };

  // Enter to send (web), Shift+Enter for newline
  const handleKeyPress = (e) => {
    if (Platform.OS !== 'web') return;
    const nativeEvent = e.nativeEvent || e;
    if (nativeEvent.key === 'Enter' && !nativeEvent.shiftKey) {
      e.preventDefault?.();
      handleSend();
    }
  };

  const handleWebFileChange = (e, isImage = false) => {
    const file = e.target?.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE_BYTES) {
      alert(`Selected file exceeds maximum allowed size of 10MB (${(file.size / (1024 * 1024)).toFixed(1)}MB).`);
      e.target.value = '';
      return;
    }

    const model = createFileModel({
      uri: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      mimeType: file.type || (isImage ? 'image/jpeg' : 'application/pdf'),
      file,
    });

    onFileSelected?.(model);
    e.target.value = '';
  };

  const handlePickDoc = () => {
    setMenuOpen(false);
    if (Platform.OS === 'web' && webDocInputRef.current) {
      webDocInputRef.current.click();
    } else {
      onPickDocument?.();
    }
  };

  const handlePickImage = () => {
    setMenuOpen(false);
    if (Platform.OS === 'web' && webImgInputRef.current) {
      webImgInputRef.current.click();
    } else {
      onPickImage?.();
    }
  };

  const handleCamera = () => {
    setMenuOpen(false);
    if (Platform.OS === 'web' && webCamInputRef.current) {
      webCamInputRef.current.click();
    } else {
      onCameraCapture?.();
    }
  };

  // ─── Inline Voice Recording & Whisper Transcription ─────────────
  const startAudioRecording = async () => {
    if (disabled || isStreaming || isRecording || isTranscribing) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      alert('Audio recording is not supported in this browser environment.');
      return;
    }

    try {
      audioChunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.start();
      setIsRecording(true);
      setRecordSeconds(0);
      timerIntervalRef.current = setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.warn('[InputBar] Mic access error:', err);
      alert('Microphone access is required to record voice messages.');
    }
  };

  const cancelRecording = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    audioChunksRef.current = [];
    setIsRecording(false);
    setIsTranscribing(false);
    setRecordSeconds(0);
  };

  const stopAndSendRecording = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
      cancelRecording();
      return;
    }

    mediaRecorderRef.current.onstop = async () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      if (audioChunksRef.current.length === 0) {
        setIsRecording(false);
        return;
      }

      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      setIsRecording(false);
      setIsTranscribing(true);

      try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        const token = useAuthStore.getState().accessToken;
        const res = await fetch(`${APP_CONFIG.apiBaseUrl}/transcribe`, {
          method: 'POST',
          headers: {
            'Bypass-Tunnel-Reminder': 'true',
            'bypass-tunnel-reminder': '1',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: formData,
        });

        if (!res.ok) {
          throw new Error(`Whisper transcription failed (HTTP ${res.status})`);
        }

        const data = await res.json();
        const transcribedText = data.text?.trim();

        if (transcribedText && transcribedText.length > 1) {
          onSend?.(transcribedText);
        } else {
          alert('No speech detected. Please speak clearly and try again.');
        }
      } catch (err) {
        console.warn('[InputBar] Transcription error:', err);
        alert(`Transcription error: ${err.message || err}`);
      } finally {
        setIsTranscribing(false);
        setRecordSeconds(0);
        audioChunksRef.current = [];
      }
    };

    mediaRecorderRef.current.stop();
  };

  const formatTimer = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const renderActionButton = () => {
    if (isStreaming) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop generating"
          onPress={handleStop}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.stopBtn,
            pressed && styles.pressed,
          ]}
        >
          <Square size={14} strokeWidth={3} color="#FFFFFF" />
        </Pressable>
      );
    }

    if (isTranscribing) {
      return (
        <View style={[styles.actionBtn, styles.recordingActiveBtn]}>
          <ActivityIndicator size="small" color="#FFFFFF" />
        </View>
      );
    }

    if (isRecording) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send recording"
          onPress={stopAndSendRecording}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.sendBtn,
            pressed && styles.pressed,
          ]}
        >
          <ArrowUp size={16} strokeWidth={2.5} color="#FFFFFF" />
        </Pressable>
      );
    }

    if (hasText || attachedFile) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.actionBtn,
            styles.sendBtn,
            !canSend && styles.sendBtnDisabled,
            pressed && canSend && styles.pressed,
          ]}
        >
          <ArrowUp size={16} strokeWidth={2.5} color="#FFFFFF" />
        </Pressable>
      );
    }

    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Record voice message"
        onPress={startAudioRecording}
        disabled={disabled}
        style={({ pressed }) => [
          styles.actionBtn,
          styles.micBtn,
          disabled && styles.disabled,
          pressed && !disabled && styles.pressed,
        ]}
      >
        <Mic size={16} strokeWidth={2} color={colors.brand} />
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      {/* Hidden Web Native File Inputs */}
      {Platform.OS === 'web' && (
        <View style={styles.hiddenInputs}>
          <input
            ref={webDocInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,application/pdf"
            style={{ display: 'none' }}
            onChange={(e) => handleWebFileChange(e, false)}
          />
          <input
            ref={webImgInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => handleWebFileChange(e, true)}
          />
          <input
            ref={webCamInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => handleWebFileChange(e, true)}
          />
        </View>
      )}

      {attachedFile ? (
        <View style={styles.attachmentPreview}>
          <FileCard file={attachedFile} onRemove={onRemoveAttachment} compact />
          {attachedFile.size > MAX_FILE_SIZE_BYTES && (
            <Text style={styles.fileSizeWarning}>
              File exceeds {MAX_FILE_SIZE_MB}MB limit. Please select a smaller file.
            </Text>
          )}
        </View>
      ) : null}

      <View style={[styles.pill, isRecording && styles.pillRecording]}>
        {/* Attach button with inline popover */}
        {!isRecording && !isTranscribing && (
          <View style={styles.attachWrapper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach file"
              onPress={() => setMenuOpen(!menuOpen)}
              disabled={disabled || isStreaming}
              style={({ pressed }) => [
                styles.attachBtn,
                pressed && !disabled && styles.pressed,
                (disabled || isStreaming) && styles.disabled,
              ]}
            >
              <Paperclip size={17} strokeWidth={2} color={colors.textMuted} />
            </Pressable>

            {/* Compact popover menu — Claude-style */}
            {menuOpen && (
              <>
                <Pressable
                  style={styles.menuBackdrop}
                  onPress={() => setMenuOpen(false)}
                />
                <View style={styles.popoverMenu}>
                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={handlePickDoc}
                    accessibilityRole="button"
                    accessibilityLabel={t('uploadPdf', language)}
                  >
                    <FileText size={16} color={colors.brand} strokeWidth={2.2} />
                    <Text style={styles.menuLabel}>{t('uploadPdf', language)}</Text>
                    <Text style={styles.menuHint}>{t('maxSizeHint', language)}</Text>
                  </Pressable>

                  <View style={styles.menuDivider} />

                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={handlePickImage}
                    accessibilityRole="button"
                    accessibilityLabel={t('uploadImage', language)}
                  >
                    <ImageIcon size={16} color={colors.brand} strokeWidth={2.2} />
                    <Text style={styles.menuLabel}>{t('uploadImage', language)}</Text>
                  </Pressable>

                  <View style={styles.menuDivider} />

                  <Pressable
                    style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    onPress={handleCamera}
                    accessibilityRole="button"
                    accessibilityLabel={t('takePhoto', language)}
                  >
                    <Camera size={16} color={colors.brand} strokeWidth={2.2} />
                    <Text style={styles.menuLabel}>{t('takePhoto', language)}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        {/* Dynamic Center Section: Recording Bar, Transcribing Indicator, or Text Input */}
        {isRecording ? (
          <View style={styles.recordingContainer}>
            <View style={styles.recordingPulseDot} />
            <Text style={styles.recordingTimer}>{formatTimer(recordSeconds)}</Text>
            <Text style={styles.recordingStatusText}>Recording audio... Tap Send when done</Text>
            <Pressable
              onPress={cancelRecording}
              style={styles.cancelRecordBtn}
              accessibilityLabel="Cancel recording"
            >
              <Trash2 size={16} color={colors.danger} strokeWidth={2} />
            </Pressable>
          </View>
        ) : isTranscribing ? (
          <View style={styles.recordingContainer}>
            <ActivityIndicator size="small" color={colors.brand} />
            <Text style={styles.transcribingText}>Transcribing audio with Whisper ASR...</Text>
          </View>
        ) : (
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            editable={!disabled && !isStreaming}
            multiline
            style={styles.input}
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
            onKeyPress={handleKeyPress}
          />
        )}

        {renderActionButton()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    zIndex: 100,
    position: 'relative',
  },
  hiddenInputs: {
    display: 'none',
    position: 'absolute',
    width: 0,
    height: 0,
    opacity: 0,
  },
  attachmentPreview: {
    marginBottom: spacing.sm,
  },
  fileSizeWarning: {
    fontSize: 11,
    color: colors.danger,
    marginTop: 4,
    paddingHorizontal: spacing.xs,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    zIndex: 200,
  },
  pillRecording: {
    borderColor: colors.danger,
    backgroundColor: '#FFF5F5',
  },
  attachWrapper: {
    position: 'relative',
    zIndex: 200,
  },
  attachBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
    color: colors.textPrimary,
    minHeight: 32,
    maxHeight: 120,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  actionBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  sendBtn: {
    backgroundColor: colors.brand,
  },
  sendBtnDisabled: {
    backgroundColor: colors.border,
  },
  stopBtn: {
    backgroundColor: colors.danger,
  },
  micBtn: {
    backgroundColor: colors.bgMuted,
  },
  recordingActiveBtn: {
    backgroundColor: colors.danger,
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.4,
  },

  // Recording UI Inside Pill
  recordingContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  recordingPulseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.danger,
  },
  recordingTimer: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.danger,
    fontVariant: ['tabular-nums'],
  },
  recordingStatusText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
  },
  transcribingText: {
    fontSize: 13,
    color: colors.brand,
    fontWeight: '500',
  },
  cancelRecordBtn: {
    padding: spacing.xs,
  },

  // Popover menu — 100% Solid Opaque Card
  menuBackdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
  },
  popoverMenu: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    minWidth: 270,
    backgroundColor: '#FFFFFF',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 16,
    zIndex: 1000,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    backgroundColor: '#FFFFFF',
    cursor: 'pointer',
  },
  menuItemPressed: {
    backgroundColor: colors.bgSubtle,
  },
  menuLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  menuHint: {
    fontSize: 11,
    color: colors.textMuted,
    backgroundColor: colors.bgMuted,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: radii.xs,
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
});
