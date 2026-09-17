import React, { useRef, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, Platform, Animated, Easing } from 'react-native';
import { Check, Copy, RotateCcw, Volume2, Square as StopIcon, Loader2 } from 'lucide-react-native';

// Platform-safe clipboard (no expo-clipboard dependency)
const ClipboardHelper = {
  setStringAsync: async (text) => {
    if (Platform.OS === 'web' && navigator?.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  },
};

import ChatBubble from './ChatBubble';
import { colors, radii, spacing } from '../../constants/theme';

/* ─── Small icon-only action button ─────────────────────────────── */
function IconAction({ icon: Icon, activeIcon: ActiveIcon, label, onPress, active = false, loading = false }) {
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (loading) {
      const loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 800,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      loop.start();
      return () => loop.stop();
    } else {
      spinAnim.setValue(0);
    }
  }, [loading, spinAnim]);

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const DisplayIcon = loading ? Loader2 : (active && ActiveIcon ? ActiveIcon : Icon);

  const iconElement = (
    <DisplayIcon
      size={14}
      strokeWidth={2.25}
      color={loading ? colors.brand : (active ? colors.brand : colors.textMuted)}
    />
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={loading ? undefined : onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.iconAction,
        (active || loading) && styles.iconActionActive,
        pressed && !loading && styles.iconActionPressed,
      ]}
    >
      {loading ? (
        <Animated.View style={Platform.OS === 'web' ? { animation: 'spinContinuous 0.8s linear infinite' } : { transform: [{ rotate: spin }] }}>
          {iconElement}
        </Animated.View>
      ) : (
        iconElement
      )}
    </Pressable>
  );
}

function CopyAction({ content }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!content) return;
    await ClipboardHelper.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <IconAction
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : 'Copy'}
      onPress={handleCopy}
      active={copied}
    />
  );
}

export default function MessageList({
  messages = [],
  onSpeak,
  onReload,
  speakingMessageId,
  isLoadingTTS = false,
  isStreaming = false,
  reloadingMessageId,
}) {
  const flatListRef = useRef(null);

  // Auto-scroll to bottom when new messages arrive or content updates
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd?.({ animated: true });
      }, 100);
    }
  }, [messages.length, messages[messages.length - 1]?.content]);

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      keyExtractor={(item, index) => String(item.id ?? index)}
      renderItem={({ item, index }) => {
        const isUser = item.role === 'user';
        const isSpeaking = speakingMessageId != null && speakingMessageId === item.id;
        const isItemLoading = isLoadingTTS && speakingMessageId === item.id;
        const isGenerating = isStreaming && index === messages.length - 1;

        return (
          <View style={styles.itemContainer}>
            <ChatBubble message={item} isUser={isUser} />
            {!isUser && item.content && !isStreaming ? (
              <View style={styles.extrasContainer}>
                {/* Action icons — compact row */}
                <View style={styles.actionRow}>
                  <IconAction
                    icon={Volume2}
                    activeIcon={StopIcon}
                    label={isSpeaking ? 'Stop reading' : isItemLoading ? 'Loading voice...' : 'Read aloud'}
                    onPress={() => onSpeak?.(item)}
                    active={isSpeaking}
                    loading={isItemLoading}
                  />
                  <CopyAction content={item.content} />
                  <IconAction
                    icon={RotateCcw}
                    label="Regenerate"
                    onPress={() => onReload?.(item)}
                  />
                </View>
              </View>
            ) : null}
          </View>
        );
      }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => {
        flatListRef.current?.scrollToEnd?.({ animated: true });
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    paddingBottom: 60,
    gap: spacing.xl,
  },
  itemContainer: {
    width: '100%',
  },
  extrasContainer: {
    marginTop: spacing.sm,
    marginLeft: 36,
    gap: spacing.sm,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  iconAction: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.bgMuted,
  },
  iconActionActive: {
    backgroundColor: colors.brandSubtle,
  },
  iconActionPressed: {
    opacity: 0.6,
  },
});
