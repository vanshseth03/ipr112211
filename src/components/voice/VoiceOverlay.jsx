import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  Leaf,
  Globe2,
  Sparkles,
} from 'lucide-react-native';

import { useLanguagePref } from '../../hooks/useLanguagePref';
import { APP_CONFIG, getRandomThinkingPhrase, t } from '../../constants/config';
import { colors, radii, spacing, shadow } from '../../constants/theme';

// ─── Orbiting Animated Botanical Leaf Node ──────────────────────
function OrbitingLeaf({ angleOffset = 0, radius = 95, size = 18, color = colors.accent, duration = 9000 }) {
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [duration, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [`${angleOffset}deg`, `${angleOffset + 360}deg`],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.orbitalRingContainer,
        {
          transform: [{ rotate: rotation }],
        },
      ]}
    >
      <View
        style={[
          styles.orbitalLeafWrap,
          {
            top: -radius,
          },
        ]}
      >
        <Leaf size={size} color={color} strokeWidth={2} />
      </View>
    </Animated.View>
  );
}

// ─── Multi-Bar Audio Soundwave ──────────────────────────────────
function LiveSoundWave({ active, color = colors.brandLight }) {
  const barCount = 7;
  const barAnims = useRef(
    Array.from({ length: barCount }, () => new Animated.Value(0.3))
  ).current;

  useEffect(() => {
    if (!active) {
      barAnims.forEach((anim) => anim.setValue(0.25));
      return;
    }

    const animations = barAnims.map((anim, idx) => {
      const duration = 350 + (idx % 3) * 120;
      return Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 0.9 + Math.random() * 0.1,
            duration,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0.2 + (idx % 2) * 0.1,
            duration,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      );
    });

    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [active, barAnims]);

  return (
    <View style={styles.soundWaveRow}>
      {barAnims.map((anim, index) => (
        <Animated.View
          key={index}
          style={[
            styles.soundWaveBar,
            {
              backgroundColor: color,
              transform: [{ scaleY: anim }],
            },
          ]}
        />
      ))}
    </View>
  );
}

export default function VoiceOverlay({
  visible = false,
  isListening = false,
  isProcessing = false,
  transcript = '',
  aiResponse = '',
  onClose,
  onStop,
}) {
  const { language, setLanguage } = useLanguagePref();
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [thinkingPhrase, setThinkingPhrase] = useState('');

  // Concentric Aura Pulses
  const pulse1 = useRef(new Animated.Value(1)).current;
  const pulse2 = useRef(new Animated.Value(1)).current;
  const pulse3 = useRef(new Animated.Value(1)).current;

  // Duration timer
  useEffect(() => {
    if (!visible) {
      setCallDuration(0);
      return;
    }
    const interval = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [visible]);

  // Rotate thinking phrase
  useEffect(() => {
    if (!visible) return;
    setThinkingPhrase(getRandomThinkingPhrase());
    const interval = setInterval(() => {
      setThinkingPhrase(getRandomThinkingPhrase());
    }, 4000);
    return () => clearInterval(interval);
  }, [visible]);

  // Breathing aura rings
  useEffect(() => {
    if (!visible) return;

    const createPulse = (val, delay, duration) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, {
            toValue: 1.25,
            duration,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );

    const a1 = createPulse(pulse1, 0, 2400);
    const a2 = createPulse(pulse2, 400, 2800);
    const a3 = createPulse(pulse3, 800, 3200);

    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [visible, pulse1, pulse2, pulse3]);

  if (!visible) return null;

  const minutes = Math.floor(callDuration / 60);
  const seconds = callDuration % 60;
  const timeFormatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const currentLangObj =
    APP_CONFIG.supportedLanguages.find((l) => l.code === language) ||
    APP_CONFIG.supportedLanguages[0];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.callContainer}>
          {/* ─── Top Header ────────────────────────────────────────── */}
          <View style={styles.header}>
            <View style={styles.headerTitleWrap}>
              <View style={styles.liveDot} />
              <Text style={styles.headerTitle}>Live Audio Session</Text>
            </View>
            <Text style={styles.timerText}>{timeFormatted}</Text>
          </View>

          {/* ─── Language Selector Pill ────────────────────────────── */}
          <View style={styles.langPillContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.langPill,
                pressed && styles.pressed,
              ]}
              onPress={() => setLangMenuOpen(!langMenuOpen)}
              accessibilityRole="button"
              accessibilityLabel="Switch language"
            >
              <Globe2 size={13} color={colors.accent} strokeWidth={2.25} />
              <Text style={styles.langPillText}>
                {currentLangObj.label} ({currentLangObj.nativeLabel})
              </Text>
            </Pressable>

            {langMenuOpen && (
              <View style={styles.langDropdown}>
                {APP_CONFIG.supportedLanguages.map((l) => (
                  <Pressable
                    key={l.code}
                    style={[
                      styles.langDropdownItem,
                      language === l.code && styles.langDropdownItemActive,
                    ]}
                    onPress={() => {
                      setLanguage(l.code);
                      setLangMenuOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.langDropdownText,
                        language === l.code && styles.langDropdownTextActive,
                      ]}
                    >
                      {l.label}
                    </Text>
                    <Text style={styles.langDropdownNative}>
                      {l.nativeLabel}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* ─── Central Botanical Orb & Orbiting Leaves ───────────── */}
          <View style={styles.orbCenterSection}>
            {/* Outer Aura Ring 3 */}
            <Animated.View
              style={[
                styles.auraRing,
                styles.auraRing3,
                { transform: [{ scale: pulse3 }] },
              ]}
            />
            {/* Middle Aura Ring 2 */}
            <Animated.View
              style={[
                styles.auraRing,
                styles.auraRing2,
                { transform: [{ scale: pulse2 }] },
              ]}
            />
            {/* Inner Aura Ring 1 */}
            <Animated.View
              style={[
                styles.auraRing,
                styles.auraRing1,
                { transform: [{ scale: pulse1 }] },
              ]}
            />

            {/* Orbiting Botanical Leaf Particles */}
            <OrbitingLeaf angleOffset={0} radius={85} size={20} color="#D4A373" duration={9000} />
            <OrbitingLeaf angleOffset={120} radius={95} size={16} color="#52B788" duration={11000} />
            <OrbitingLeaf angleOffset={240} radius={90} size={18} color="#74C69D" duration={8000} />

            {/* Core Orb Center */}
            <View style={styles.coreOrb}>
              <View style={styles.coreOrbInner}>
                <Leaf size={32} color="#FFFFFF" strokeWidth={2.2} />
              </View>
            </View>
          </View>

          {/* ─── Status & Dynamic Phrase ──────────────────────────── */}
          <View style={styles.statusSection}>
            <View style={styles.statusBadge}>
              <Sparkles size={14} color={colors.accent} strokeWidth={2.2} />
              <Text style={styles.statusBadgeText}>
                {isMuted
                  ? t('microphoneMuted', language)
                  : isListening
                  ? t('listening', language)
                  : isProcessing
                  ? 'Processing...'
                  : 'Speaking...'}
              </Text>
            </View>
            <Text style={styles.thinkingPhraseText}>
              {isProcessing ? thinkingPhrase : isListening ? 'Speak now...' : ''}
            </Text>

            {/* Live Waveform */}
            <LiveSoundWave active={isListening && !isMuted} color={colors.accent} />
          </View>

          {/* ─── Live Transcript + AI Response ────────────────── */}
          <View style={styles.transcriptCard}>
            <Text style={styles.transcriptLabel}>YOU SAID</Text>
            <Text style={styles.transcriptText} numberOfLines={2}>
              {transcript || (isListening ? t('voicePlaceholder', language) : 'Waiting...')}
            </Text>
            {aiResponse ? (
              <>
                <Text style={[styles.transcriptLabel, { marginTop: 10, color: '#52B788' }]}>AI RESPONSE</Text>
                <Text style={styles.transcriptText} numberOfLines={4}>
                  {aiResponse}
                </Text>
              </>
            ) : null}
          </View>

          {/* ─── Bottom Call Controls ──────────────────────────────── */}
          <View style={styles.controlsRow}>
            {/* Mute Button */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              onPress={() => setIsMuted(!isMuted)}
              style={({ pressed }) => [
                styles.controlBtn,
                isMuted && styles.controlBtnActiveMute,
                pressed && styles.pressed,
              ]}
            >
              {isMuted ? (
                <MicOff size={20} color="#FFFFFF" strokeWidth={2.2} />
              ) : (
                <Mic size={20} color={colors.navTextActive} strokeWidth={2.2} />
              )}
            </Pressable>

            {/* End Call Button */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End audio call"
              onPress={() => {
                onStop?.();
                onClose?.();
              }}
              style={({ pressed }) => [
                styles.endCallBtn,
                pressed && styles.pressed,
              ]}
            >
              <PhoneOff size={24} color="#FFFFFF" strokeWidth={2.5} />
            </Pressable>

            {/* Speaker / Feedback */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Audio status"
              style={styles.controlBtn}
            >
              <Volume2 size={20} color={colors.navTextActive} strokeWidth={2.2} />
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(5, 15, 10, 0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
  },
  callContainer: {
    width: '100%',
    maxWidth: 440,
    borderRadius: radii.xxl,
    backgroundColor: '#091E13',
    borderWidth: 1,
    borderColor: 'rgba(82, 183, 136, 0.25)',
    padding: spacing.xl,
    alignItems: 'center',
    ...shadow.overlay,
    overflow: 'hidden',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#52B788',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FEFCF6',
    letterSpacing: -0.2,
  },
  timerText: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(254, 252, 246, 0.65)',
    fontVariant: ['tabular-nums'],
  },

  // Language Pill
  langPillContainer: {
    marginTop: spacing.md,
    zIndex: 20,
    position: 'relative',
  },
  langPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(212, 163, 115, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(212, 163, 115, 0.35)',
  },
  langPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
  },
  langDropdown: {
    position: 'absolute',
    top: 32,
    left: -40,
    width: 200,
    maxHeight: 200,
    backgroundColor: '#0F2D1E',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: 'rgba(82, 183, 136, 0.3)',
    ...shadow.lg,
    zIndex: 30,
    overflow: 'hidden',
  },
  langDropdownItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  langDropdownItemActive: {
    backgroundColor: 'rgba(82, 183, 136, 0.2)',
  },
  langDropdownText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FEFCF6',
  },
  langDropdownTextActive: {
    color: colors.accent,
  },
  langDropdownNative: {
    fontSize: 11,
    color: 'rgba(254, 252, 246, 0.6)',
  },

  // Central Orb
  orbCenterSection: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.xl,
    position: 'relative',
  },
  auraRing: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 1,
  },
  auraRing1: {
    width: 130,
    height: 130,
    borderColor: 'rgba(82, 183, 136, 0.45)',
    backgroundColor: 'rgba(45, 106, 79, 0.25)',
  },
  auraRing2: {
    width: 170,
    height: 170,
    borderColor: 'rgba(212, 163, 115, 0.25)',
    backgroundColor: 'rgba(212, 163, 115, 0.06)',
  },
  auraRing3: {
    width: 210,
    height: 210,
    borderColor: 'rgba(82, 183, 136, 0.15)',
    backgroundColor: 'rgba(45, 106, 79, 0.04)',
  },

  // Orbital Leaf Node
  orbitalRingContainer: {
    position: 'absolute',
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbitalLeafWrap: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(15, 45, 30, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(212, 163, 115, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.sm,
  },

  // Core Orb
  coreOrb: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.accent,
    ...shadow.md,
  },
  coreOrbInner: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: colors.brandLight,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Status & Wave
  statusSection: {
    alignItems: 'center',
    gap: spacing.xs + 2,
    marginBottom: spacing.md,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statusBadgeText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FEFCF6',
  },
  thinkingPhraseText: {
    fontSize: 12,
    color: 'rgba(254, 252, 246, 0.6)',
    fontStyle: 'italic',
    textAlign: 'center',
    maxWidth: 280,
  },
  soundWaveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: 30,
    marginTop: spacing.xs,
  },
  soundWaveBar: {
    width: 4,
    height: 24,
    borderRadius: 2,
  },

  // Transcript
  transcriptCard: {
    width: '100%',
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    marginBottom: spacing.lg,
  },
  transcriptLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.accent,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  transcriptText: {
    fontSize: 12,
    color: 'rgba(254, 252, 246, 0.85)',
    lineHeight: 18,
  },

  // Bottom Controls
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    width: '100%',
  },
  controlBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnActiveMute: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  endCallBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.md,
  },
  pressed: {
    opacity: 0.75,
    transform: [{ scale: 0.96 }],
  },
});
