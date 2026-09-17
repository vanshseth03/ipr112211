import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  Pressable,
  Easing,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Leaf, Plus, Trash2, ArrowRight, Loader2 } from 'lucide-react-native';

import MessageList from '../../components/chat/MessageList';
import InputBar from '../../components/chat/InputBar';

import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useHistoryStore } from '../../store/historyStore';
import { useAuthStore } from '../../store/authStore';
import { useLanguagePref } from '../../hooks/useLanguagePref';
import { useSpeak } from '../../hooks/useSpeak';
import { useFileUpload } from '../../hooks/useFileUpload';

import { sendMessage, streamChatMessage } from '../../services/chatService';
import { createChatMessage, CHAT_ROLES } from '../../models/chat';
import {
  APP_CONFIG,
  getRandomThinkingPhrase,
  t,
  fetchServerRegistry,
  triggerServerStart,
  waitForServer,
} from '../../constants/config';
import { colors, spacing, typography, radii, shadow } from '../../constants/theme';

const SUGGESTED_PROMPTS = [
  { text: 'Is Ashwagandha root extract patentable under Indian law?', tag: 'Section 3(p)' },
  { text: 'What TKDL prior art exists for Turmeric / Curcumin formulations?', tag: 'Prior Art' },
  { text: 'How do I demonstrate non-obvious synergy for polyherbal extracts?', tag: 'Synergy' },
  { text: 'What are the Ayush Premium Mark export compliance steps?', tag: 'Compliance' },
];

// ─── Floating leaf particle (decorative animation) ───────────────
function FloatingLeaf({ delay = 0 }) {
  const translateY = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const startX = Math.random() * 320;
    translateX.setValue(startX);

    const animate = () => {
      opacity.setValue(0);
      translateY.setValue(-20);
      rotate.setValue(0);

      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(translateY, {
            toValue: 620,
            duration: 9000 + Math.random() * 4000,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.18,
            duration: 2000,
            useNativeDriver: true,
          }),
          Animated.timing(rotate, {
            toValue: 1,
            duration: 9000 + Math.random() * 4000,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        ]),
      ]).start(() => animate());
    };

    animate();
  }, [delay, opacity, rotate, translateX, translateY]);

  const rotateInterp = rotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.floatingLeaf,
        {
          transform: [
            { translateY },
            { translateX },
            { rotate: rotateInterp },
          ],
          opacity,
        },
      ]}
    >
      <Leaf size={16} color={colors.brand} strokeWidth={1.5} />
    </Animated.View>
  );
}

// ─── Server Starting Banner ──────────────────────────────────
function ServerStartingBanner({ visible, statusText }) {
  if (!visible) return null;

  return (
    <View style={styles.serverBanner}>
      <ActivityIndicator size="small" color={colors.brand} style={{ marginRight: 8 }} />
      <Text style={styles.serverBannerText}>
        {statusText || 'Starting server — loading AI models, please wait...'}
      </Text>
    </View>
  );
}

// ─── Thinking status bar during streaming ────────────────────────
function ThinkingBar({ visible, language = 'en' }) {
  const [phrase, setPhrase] = useState(getRandomThinkingPhrase(language));
  const pulse = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    if (!visible) return;
    setPhrase(getRandomThinkingPhrase(language));
    const interval = setInterval(() => {
      setPhrase(getRandomThinkingPhrase(language));
    }, 2800);
    return () => clearInterval(interval);
  }, [visible, language]);

  useEffect(() => {
    if (!visible) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [visible, pulse]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.thinkingBar, { opacity: pulse }]}>
      <View style={styles.thinkingDot} />
      <Text style={styles.thinkingText}>{phrase}</Text>
    </Animated.View>
  );
}

export default function ChatScreen() {
  const {
    messages,
    addMessage,
    updateMessage,
    clearMessages,
    newConversation,
    isStreaming,
    setIsStreaming,
    setSseConnection,
    stopStreaming,
  } = useChatStore();
  const { jurisdiction } = useSettingsStore();
  const { language } = useLanguagePref();
  const { addItem: addHistoryItem } = useHistoryStore();
  const { speak, stop: stopSpeak, isSpeaking, isLoadingTTS, speakingMessageId } = useSpeak();
  const {
    file: attachedFile,
    setFile: setAttachedFile,
    selectDocument,
    selectImage,
    captureCameraPhoto,
    clearFile: clearAttachedFile,
  } = useFileUpload();

  // Server auto-start state
  const [serverStarting, setServerStarting] = useState(false);
  const [serverBannerText, setServerBannerText] = useState('');
  const pendingMessageRef = useRef(null);

  useEffect(() => {
    // Always open a fresh new chat when a new session is initiated
    newConversation();
    addMessage(
      createChatMessage({
        role: CHAT_ROLES.ASSISTANT,
        content:
          'Welcome to the **Ayurveda IPR Assistant**.\n\nI can help you evaluate **patentability under Section 3(p)**, check **Traditional Knowledge Digital Library (TKDL)** prior art, analyze polyherbal synergy, and guide Ayush certification.\n\nHow may I assist your formulation research today?',
      })
    );
  }, []);

function detectQueryLanguage(text) {
  if (!text) return 'en';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  const hinglishWords = new Set([
    'kya', 'hai', 'hain', 'ke', 'ki', 'ko', 'ka', 'me', 'mein', 'se', 'sb', 'sab',
    'btayo', 'batao', 'bataiye', 'karo', 'karein', 'baare', 'barein', 'hota', 'hoti',
    'hote', 'nahi', 'nahin', 'na', 'mat', 'liye', 'kaise', 'kaisa', 'kahan', 'kab',
    'kyun', 'kyu', 'namaste', 'namaskar', 'bhi', 'kuch', 'aur', 'karna', 'kariye',
    'kijiye', 'chahiye', 'sakta', 'sakti', 'sakte', 'btao'
  ]);
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  let matches = 0;
  for (const w of words) {
    if (hinglishWords.has(w)) matches++;
  }
  return (matches >= 2 || (words.length <= 6 && matches >= 1)) ? 'hi' : 'en';
}

  const handleSend = async (text) => {
    const trimmed = text?.trim() || '';
    if ((!trimmed && !attachedFile) || isStreaming) return;

    let fullPrompt = trimmed;
    if (attachedFile) {
      const sizeStr = attachedFile.size ? ` (${(attachedFile.size / 1024).toFixed(1)}KB)` : '';
      const fileHeader = `[Attached ${attachedFile.type === 'image' ? 'Image' : 'Document'}: ${attachedFile.name}${sizeStr}]`;
      
      let docExcerpt = '';
      if (attachedFile.file) {
        try {
          const fname = attachedFile.name?.toLowerCase() || '';
          const isPdf = fname.endsWith('.pdf') || attachedFile.mimeType?.includes('pdf');
          const isImage = fname.endsWith('.png') || fname.endsWith('.jpg') || fname.endsWith('.jpeg') || attachedFile.mimeType?.includes('image');

          if (isPdf || isImage) {
            const formData = new FormData();
            formData.append('file', attachedFile.file, attachedFile.name);
            const token = useAuthStore.getState().accessToken;

            const extractRes = await fetch(`${APP_CONFIG.apiBaseUrl}/document/extract`, {
              method: 'POST',
              headers: {
                'Bypass-Tunnel-Reminder': 'true',
                'bypass-tunnel-reminder': '1',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: formData,
            });

            if (extractRes.ok) {
              const extractData = await extractRes.json();
              if (extractData.text && extractData.text.trim()) {
                docExcerpt = `\n\n--- Extracted Document Content (${(extractData.file_type || 'DOC').toUpperCase()}: ${extractData.filename}) ---\n${extractData.text.trim()}`;
              }
            }
          } else if (typeof attachedFile.file.text === 'function') {
            const rawText = await attachedFile.file.text();
            if (rawText && rawText.trim()) {
              docExcerpt = `\n\n--- Document Content ---\n${rawText.trim().slice(0, 6000)}`;
            }
          }
        } catch (e) {
          console.warn('[Chat] Could not extract text from document:', e);
        }
      }

      fullPrompt = trimmed
        ? `${fileHeader}${docExcerpt}\n\n${trimmed}`
        : `${fileHeader}${docExcerpt}\nPlease analyze this formulation document for TKDL prior art overlap and Section 3(p) patentability.`;
    }

    const detectedLang = detectQueryLanguage(fullPrompt);
    const effectiveLang = (language === 'hi' || detectedLang === 'hi') ? 'hi' : 'en';

    // Build clean, strictly alternating conversation history for multi-turn context
    const validHistoryMessages = messages.filter(
      (m) =>
        (m.role === CHAT_ROLES.USER || m.role === CHAT_ROLES.ASSISTANT) &&
        m.content &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0 &&
        !m.isBooting
    );

    const chatHistory = [];
    let expectedRole = CHAT_ROLES.USER;
    for (const m of validHistoryMessages.slice(-8)) {
      if (m.role === expectedRole) {
        chatHistory.push({ role: m.role, content: m.content.trim() });
        expectedRole = expectedRole === CHAT_ROLES.USER ? CHAT_ROLES.ASSISTANT : CHAT_ROLES.USER;
      }
    }
    // Multi-turn context must end on an assistant turn so current query is the alternating user turn
    while (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role !== CHAT_ROLES.ASSISTANT) {
      chatHistory.pop();
    }

    const userMsg = createChatMessage({ role: CHAT_ROLES.USER, content: fullPrompt });
    addMessage(userMsg);
    clearAttachedFile();

    const assistantMsgId = `msg-${Date.now()}`;
    addMessage(createChatMessage({ id: assistantMsgId, role: CHAT_ROLES.ASSISTANT, content: '' }));

    setIsStreaming(true);
    let accumulatedText = '';

    // ─── Check if server is available, auto-start if needed ───
    // ALWAYS prompts /api/health FIRST to acknowledge whether server is actually present!
    const reg = await fetchServerRegistry(true);
    if (!reg?.url || !reg?.ready) {
      setServerStarting(true);
      const initialStep = reg?.needRepush ? 'pushing' : (reg?.step || 'checking');
      const initialMsg = reg?.needRepush
        ? 'Server offline. Triggering Kaggle GPU kernel push...'
        : (reg?.stepDisplay || 'Pinging server health and checking models...');

      setServerBannerText(initialMsg);

      // Store pending message to re-send after server is up
      pendingMessageRef.current = { fullPrompt, effectiveLang, chatHistory, assistantMsgId };

      // Set assistant message to server booting state with animated spinner card
      updateMessage(assistantMsgId, {
        isBooting: true,
        bootStep: initialStep,
        bootStepDisplay: initialMsg,
        content: '',
      });

      // If repush needed, trigger daemon
      if (reg?.needRepush || reg?.status === 'offline') {
        const trigger = await triggerServerStart();
        if (trigger?.triggered) {
          setServerBannerText('Kaggle kernel pushed! Initializing GPU container...');
          updateMessage(assistantMsgId, {
            isBooting: true,
            bootStep: 'pushing',
            bootStepDisplay: 'Kaggle GPU kernel pushed. Waiting for Cloudflare tunnel URL...',
            content: '',
          });
        }
      }

      // Webpage enters continuous loop with Cloudflare tunnel /api/health.
      // NEVER QUITS. Locks the architecture into the loop until server is completely ready!
      const url = await waitForServer((status) => {
        setServerBannerText(status.message);
        updateMessage(assistantMsgId, {
          isBooting: true,
          bootStep: status.step,
          bootStepDisplay: status.message,
          bootUrl: status.url,
          content: '',
        });
      });

      // Server is now completely ready!
      setServerBannerText('Server ready! Generating response...');
      updateMessage(assistantMsgId, {
        isBooting: true,
        bootStep: 'ready',
        bootStepDisplay: 'All models loaded. AI Legal Advisory ready!',
        content: '',
      });

      // Brief transition delay so user observes the ready confirmation
      await new Promise((r) => setTimeout(r, 400));

      setServerStarting(false);
      updateMessage(assistantMsgId, {
        isBooting: false,
        content: '',
      });
      accumulatedText = '';
    }

    // Enhance outgoing query with domain grounding to prevent LLM precedent hallucinations
    let outgoingQuery = fullPrompt;
    const lowerPrompt = fullPrompt.toLowerCase();
    if (lowerPrompt.includes('turmeric') || lowerPrompt.includes('curcumin') || lowerPrompt.includes('haridra')) {
      if (!lowerPrompt.includes('divya pharmacy')) {
        outgoingQuery = `${fullPrompt}\n\n[Legal Precedent Grounding: The Turmeric patent revocation was USPTO Patent 5,401,504 challenged by CSIR using classical treatises (Charaka Samhita, Sushruta Samhita). Divya Pharmacy v. Union of India (2018) is strictly about Biological Diversity Act ABS benefit sharing and is NOT related to turmeric.]`;
      }
    } else if (lowerPrompt.includes('neem') || lowerPrompt.includes('azadirachta')) {
      if (!lowerPrompt.includes('divya pharmacy')) {
        outgoingQuery = `${fullPrompt}\n\n[Legal Precedent Grounding: The Neem patent revocation was EPO Patent 436,257 challenged by Vandana Shiva/EPO for fungicidal use. Divya Pharmacy is strictly about Biological Diversity Act ABS.]`;
      }
    }

    try {
      const connection = streamChatMessage(outgoingQuery, {
        jurisdiction,
        language: effectiveLang,
        messages: chatHistory,
        onToken: (token) => {
          accumulatedText += token;
          updateMessage(assistantMsgId, { content: accumulatedText });
        },
        onSources: () => {},
        onComplete: () => {
          setIsStreaming(false);
          setSseConnection(null);
          addHistoryItem({
            type: 'chat',
            title: fullPrompt.length > 35 ? `${fullPrompt.slice(0, 35)}...` : fullPrompt,
            summary: accumulatedText.slice(0, 80) + '...',
            data: { query: fullPrompt, response: accumulatedText, jurisdiction },
          });
        },
        onError: async (err) => {
          console.warn('[SSE fallback]:', err);
          if (!accumulatedText) {
            try {
              const res = await sendMessage(outgoingQuery, { jurisdiction, language: effectiveLang, messages: chatHistory });
              updateMessage(assistantMsgId, { content: res.answer || res.content || 'Analysis completed.' });
            } catch (fallbackErr) {
              updateMessage(assistantMsgId, { content: `Unable to complete query: ${fallbackErr.message || err.message}` });
            }
          }
          setIsStreaming(false);
          setSseConnection(null);
        },
      });
      setSseConnection(connection);
    } catch (err) {
      updateMessage(assistantMsgId, { content: `Error: ${err.message}` });
      setIsStreaming(false);
      setSseConnection(null);
    }
  };

  const handleSpeakMessage = useCallback(
    (message) => {
      if (speakingMessageId === message.id) {
        stopSpeak();
        return;
      }
      const isMsgHindi = /[\u0900-\u097F]/.test(message.content || '') || language === 'hi';
      speak(message.content, {
        language: isMsgHindi ? 'hi-IN' : 'en-IN',
      }, message.id);
    },
    [language, speak, speakingMessageId, stopSpeak]
  );

  const handleNewChat = () => {
    if (isStreaming) stopStreaming();
    newConversation();
  };

  const showWelcome = messages.length <= 1;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
      {/* Decorative floating leaves */}
      <View style={styles.particleContainer} pointerEvents="none">
        <FloatingLeaf delay={0} />
        <FloatingLeaf delay={2000} />
        <FloatingLeaf delay={4500} />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.newChatBtn, pressed && styles.pressed]}
          onPress={handleNewChat}
          accessibilityRole="button"
          accessibilityLabel="New conversation"
        >
          <Plus size={14} color={colors.brand} strokeWidth={2.5} />
          <Text style={styles.newChatText}>{t('newChat', language)}</Text>
        </Pressable>
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={clearMessages}
          accessibilityRole="button"
          accessibilityLabel="Clear conversation"
        >
          <Trash2 size={16} color={colors.textMuted} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      {/* Server Starting Status Banner with Spinning Icon */}
      <ServerStartingBanner visible={serverStarting} statusText={serverBannerText} />

      {/* Thinking indicator */}
      <ThinkingBar visible={isStreaming && !serverStarting} language={language} />

      {/* Chat area */}
      <View style={styles.chatContainer}>
        {showWelcome && (
          <View style={styles.welcomeSection}>
            <View style={styles.welcomeBrand}>
              <View style={styles.welcomeIcon}>
                <Leaf size={24} color={colors.accent} strokeWidth={2} />
              </View>
              <Text style={styles.welcomeTitle}>{t('appName', language)}</Text>
              <Text style={styles.welcomeSubtitle}>
                {t('chatSubtitle', language)}
              </Text>
            </View>
            <View style={styles.promptGrid}>
              {[
                { text: t('prompt1', language), tag: t('prompt1Tag', language) },
                { text: t('prompt2', language), tag: t('prompt2Tag', language) },
                { text: t('prompt3', language), tag: t('prompt3Tag', language) },
                { text: t('prompt4', language), tag: t('prompt4Tag', language) },
              ].map((prompt, idx) => (
                <Pressable
                  key={idx}
                  style={({ pressed }) => [styles.promptCard, pressed && styles.promptCardPressed]}
                  onPress={() => handleSend(prompt.text)}
                  accessibilityRole="button"
                  accessibilityLabel={prompt.text}
                >
                  <Text style={styles.promptTag}>{prompt.tag}</Text>
                  <Text style={styles.promptText} numberOfLines={2}>{prompt.text}</Text>
                  <ArrowRight size={14} color={colors.brandLight} strokeWidth={2} />
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <MessageList
          messages={messages}
          onSpeak={handleSpeakMessage}
          speakingMessageId={speakingMessageId}
          isLoadingTTS={isLoadingTTS}
          isStreaming={isStreaming}
        />
      </View>

      {/* Input */}
      <InputBar
        onSend={handleSend}
        onStopStreaming={stopStreaming}
        onPickDocument={selectDocument}
        onPickImage={selectImage}
        onCameraCapture={captureCameraPhoto}
        onFileSelected={setAttachedFile}
        attachedFile={attachedFile}
        onRemoveAttachment={clearAttachedFile}
        isStreaming={isStreaming}
        language={language}
        placeholder={t('placeholder', language)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bg },

  // Floating leaf particles
  particleContainer: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 0,
    overflow: 'hidden',
  },
  floatingLeaf: {
    position: 'absolute',
    top: 0,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    zIndex: 1,
  },
  newChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  newChatText: { fontSize: 13, fontWeight: '600', color: colors.brand },
  clearBtn: { padding: spacing.sm, borderRadius: radii.md },
  pressed: { opacity: 0.7 },

  // Server Starting Banner
  serverBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderAccent,
    zIndex: 2,
  },
  serverBannerText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.brand,
    flex: 1,
  },

  // Thinking bar
  thinkingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderAccent,
    zIndex: 1,
  },
  thinkingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.brand,
  },
  thinkingText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    fontStyle: 'italic',
  },

  // Chat container
  chatContainer: { flex: 1, backgroundColor: 'transparent', zIndex: 1 },

  // Welcome
  welcomeSection: { padding: spacing.xl, paddingTop: spacing.xxxl, alignItems: 'center' },
  welcomeBrand: { alignItems: 'center', marginBottom: spacing.xl },
  welcomeIcon: {
    width: 52, height: 52, borderRadius: radii.lg,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1, borderColor: colors.borderAccent,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  welcomeTitle: {
    fontSize: 22, fontWeight: '700', color: colors.textPrimary,
    textAlign: 'center', letterSpacing: -0.5,
  },
  welcomeSubtitle: {
    ...typography.bodySmall, textAlign: 'center',
    marginTop: spacing.xs, maxWidth: 320, color: colors.textMuted,
  },
  promptGrid: { width: '100%', maxWidth: 600, gap: spacing.sm },
  promptCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceRaised, ...shadow.sm,
  },
  promptCardPressed: { backgroundColor: colors.bgSubtle, borderColor: colors.brandLight },
  promptTag: {
    fontSize: 10, fontWeight: '700', color: colors.brand,
    backgroundColor: colors.brandSubtle,
    paddingHorizontal: spacing.sm, paddingVertical: 2,
    borderRadius: radii.xs, overflow: 'hidden',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  promptText: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.textPrimary, lineHeight: 18 },
});
