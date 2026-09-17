import React, { useRef, useEffect } from 'react';
import { StyleSheet, Text, View, Animated, Easing, Platform, ActivityIndicator } from 'react-native';
import { Leaf, Cpu } from 'lucide-react-native';
import { colors, radii, spacing, typography } from '../../constants/theme';

/**
 * Server Boot & Model Loading Card
 * Displays animated loading spinner with live state text beneath it,
 * reflecting exact progress from /api/health (loading weights, FAISS, etc.).
 */
function ServerBootCard({ step, stepDisplay, url }) {
  const pulseAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 750, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 750, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    pulse.start();
    return () => {
      pulse.stop();
    };
  }, [pulseAnim]);

  // Interpret boot phase
  let phaseTitle = 'Initializing AI Server';
  let phaseBadge = 'Booting';
  if (step === 'loading_llm' || step?.includes('llm') || step?.includes('weight')) {
    phaseTitle = 'Loading Model Weights';
    phaseBadge = 'Gemma-2-2B-IT';
  } else if (step === 'loading_reranker') {
    phaseTitle = 'Loading Cross-Encoder Reranker';
    phaseBadge = 'BGE-Reranker-V2';
  } else if (step === 'building_index') {
    phaseTitle = 'Building Hybrid Vector Index';
    phaseBadge = 'FAISS + BM25';
  } else if (step === 'loading_embeddings') {
    phaseTitle = 'Loading Embedding Model';
    phaseBadge = 'BGE-M3';
  } else if (step === 'loading_rag_db') {
    phaseTitle = 'Loading Statutory Database';
    phaseBadge = '4,678 Records';
  } else if (step === 'tunnel_pending' || step === 'tunnel_warming' || step === 'tunnel_connecting') {
    phaseTitle = 'Cloudflare Tunnel Handshake';
    phaseBadge = 'trycloudflare.com';
  } else if (step === 'kernel_booting' || step === 'pushing') {
    phaseTitle = 'Allocating Kaggle T4 GPU';
    phaseBadge = 'Tesla T4 Dual';
  } else if (step === 'ready') {
    phaseTitle = 'Server Ready! Answering Question...';
    phaseBadge = 'Connected';
  }

  const currentDisplay = stepDisplay || 'Loading model weights into GPU...';

  return (
    <View style={styles.bootCard}>
      {/* Centered Loading Icon with Glowing Ring */}
      <View style={styles.bootIconContainer}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>

      {/* State Beneath Loading Icon */}
      <View style={styles.bootTextContainer}>
        <Text style={styles.bootPhaseTitle}>{phaseTitle}</Text>
        <Text style={styles.bootStateBeneath}>{currentDisplay}</Text>
      </View>

      {/* Progress pill indicators */}
      <View style={styles.bootPillsRow}>
        <Animated.View style={[styles.bootLiveBadge, { opacity: pulseAnim }]}>
          <View style={styles.bootLiveDot} />
          <Text style={styles.bootLiveText}>{phaseBadge}</Text>
        </Animated.View>

        <View style={styles.bootChip}>
          <Cpu size={12} color={colors.brand} strokeWidth={2} />
          <Text style={styles.bootChipText}>Kaggle Dual T4 (32GB VRAM)</Text>
        </View>
      </View>

      {/* Explanatory lock-in notice */}
      <Text style={styles.bootLockNotice}>
        Locked into live loop with server health. Response will stream automatically once models finish loading.
      </Text>
    </View>
  );
}

/**
 * Render inline **bold** and *italic* from markdown.
 * Intentionally simple — covers the most common patterns.
 */
function renderInline(text, baseStyle) {
  // Split on **bold** and *italic*
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, idx) => {
    const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) {
      return (
        <Text key={idx} style={[baseStyle, styles.bold]}>
          {boldMatch[1]}
        </Text>
      );
    }
    const italicMatch = part.match(/^\*([^*]+)\*$/);
    if (italicMatch) {
      return (
        <Text key={idx} style={[baseStyle, styles.italic]}>
          {italicMatch[1]}
        </Text>
      );
    }
    return (
      <Text key={idx} style={baseStyle}>
        {part}
      </Text>
    );
  });
}

/**
 * Parse text into paragraphs and bullet points.
 */
function renderContent(text, baseStyle) {
  const lines = text.split('\n');
  const elements = [];
  let key = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      elements.push(<View key={key++} style={styles.paragraphGap} />);
      continue;
    }

    // Horizontal divider
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      elements.push(<View key={key++} style={styles.divider} />);
      continue;
    }

    // Markdown headers (## Header, ### Header, # Header)
    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      const headerStyle = level <= 2 ? styles.headerH2 : styles.headerH3;
      elements.push(
        <Text key={key++} style={[baseStyle, headerStyle]}>
          {renderInline(headerText, [baseStyle, headerStyle])}
        </Text>
      );
      continue;
    }

    // Bullet points
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      const bulletText = trimmed.replace(/^[-•*]\s+/, '');
      elements.push(
        <View key={key++} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={baseStyle}>{renderInline(bulletText, baseStyle)}</Text>
        </View>
      );
      continue;
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      elements.push(
        <View key={key++} style={styles.bulletRow}>
          <Text style={[baseStyle, styles.bulletNum]}>{numMatch[1]}.</Text>
          <Text style={baseStyle}>{renderInline(numMatch[2], baseStyle)}</Text>
        </View>
      );
      continue;
    }

    // Normal text
    elements.push(
      <Text key={key++} style={baseStyle}>
        {renderInline(trimmed, baseStyle)}
      </Text>
    );
  }

  return elements;
}

export default function ChatBubble({ message, isUser = false }) {
  const text =
    typeof message === 'string'
      ? message
      : message?.content ?? message?.text ?? '';

  if (isUser) {
    return (
      <View style={styles.userWrapper}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{text}</Text>
        </View>
      </View>
    );
  }

  // Assistant — document-style with avatar
  const isBooting = message?.isBooting && !text;

  return (
    <View style={styles.assistantWrapper}>
      <View style={styles.avatarCol}>
        <View style={styles.avatar}>
          <Leaf size={14} color={colors.accent} strokeWidth={2.5} />
        </View>
      </View>
      <View style={styles.assistantContent}>
        {isBooting ? (
          <ServerBootCard
            step={message?.bootStep}
            stepDisplay={message?.bootStepDisplay}
            url={message?.bootUrl}
          />
        ) : text ? (
          renderContent(text, styles.assistantText)
        ) : (
          <View style={styles.typingRow}>
            <View style={[styles.typingDot, styles.typingDot1]} />
            <View style={[styles.typingDot, styles.typingDot2]} />
            <View style={[styles.typingDot, styles.typingDot3]} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // User bubble
  userWrapper: {
    alignItems: 'flex-end',
    width: '100%',
  },
  userBubble: {
    maxWidth: '80%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.xl,
    borderBottomRightRadius: radii.xs,
    backgroundColor: colors.userBubble,
  },
  userText: {
    ...typography.body,
    color: colors.userBubbleText,
  },

  // Assistant
  assistantWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: '100%',
    gap: spacing.sm,
  },
  avatarCol: {
    paddingTop: 2,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderAccent,
  },
  assistantContent: {
    flex: 1,
    paddingTop: 2,
  },
  assistantText: {
    ...typography.body,
    color: colors.textPrimary,
  },

  // Formatting
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  headerH2: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.brand,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  headerH3: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.xs,
    marginBottom: spacing.xs / 2,
  },
  divider: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.sm,
    width: '100%',
  },
  paragraphGap: {
    height: spacing.sm,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingLeft: spacing.xs,
    marginVertical: 1,
  },
  bulletDot: {
    ...typography.body,
    color: colors.accent,
    fontWeight: '700',
    lineHeight: 24,
  },
  bulletNum: {
    fontWeight: '600',
    color: colors.textMuted,
    minWidth: 18,
  },

  // Typing indicator
  typingRow: {
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.brandLight,
    opacity: 0.5,
  },
  typingDot1: {},
  typingDot2: {},
  typingDot3: {},

  // Server Boot Loading Card styles
  bootCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    padding: spacing.lg,
    marginVertical: spacing.xs,
    alignItems: 'center',
    maxWidth: 520,
    width: '100%',
    shadowColor: colors.brand,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  bootIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1.5,
    borderColor: colors.borderAccent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  bootSpinner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bootTextContainer: {
    alignItems: 'center',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  bootPhaseTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.brand,
    marginBottom: 4,
    textAlign: 'center',
  },
  bootStateBeneath: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
  bootPillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  bootLiveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.full,
    backgroundColor: colors.brandSubtle,
  },
  bootLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.brand,
  },
  bootLiveText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.brand,
    textTransform: 'uppercase',
  },
  bootChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bootChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  bootLockNotice: {
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
    textAlign: 'center',
    lineHeight: 15,
    marginTop: spacing.xs,
  },
});
