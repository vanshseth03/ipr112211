import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  MessageSquare,
  FileText,
  FlaskConical,
  ScrollText,
  ArrowRight,
  Trash2,
  Clock,
} from 'lucide-react-native';

import { useHistoryStore } from '../../store/historyStore';
import { useChatStore } from '../../store/chatStore';
import { useLanguagePref } from '../../hooks/useLanguagePref';
import { t } from '../../constants/config';
import { colors, radii, spacing, typography, shadow } from '../../constants/theme';

const TYPE_META = {
  chat: { label: 'Chat', icon: MessageSquare, bg: colors.brandSubtle, fg: colors.brand },
  scan: { label: 'Scan', icon: FileText, bg: '#E4F1F7', fg: '#1B6B93' },
  classify: { label: 'Classify', icon: FlaskConical, bg: colors.accentSubtle, fg: colors.gold[700] },
  default: { label: 'Other', icon: ScrollText, bg: colors.bgMuted, fg: colors.textSecondary },
};

function typeMeta(type) {
  return TYPE_META[type] ?? TYPE_META.default;
}

export default function HistoryScreen() {
  const router = useRouter();
  const { language } = useLanguagePref();
  const { historyItems, deleteItem, clearHistory } = useHistoryStore();
  const { addMessage } = useChatStore();

  const [activeFilter, setActiveFilter] = useState('all');

  const filteredItems = historyItems.filter((item) => {
    if (activeFilter === 'all') return true;
    return item.type === activeFilter;
  });

  const handleOpenItem = (item) => {
    if (item.data?.query) {
      addMessage({
        id: `msg-${item.id}`,
        role: 'user',
        content: item.data.query,
      });
      if (item.data.response) {
        addMessage({
          id: `msg-${item.id}-resp`,
          role: 'assistant',
          content: item.data.response,
        });
      }
    }
    router.push('/chat');
  };

  const handleConfirmClear = () => {
    Alert.alert(
      t('confirmClearTitle', language),
      t('confirmClearMsg', language),
      [
        { text: t('cancel', language), style: 'cancel' },
        { text: t('clearAll', language), style: 'destructive', onPress: clearHistory },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.headerTitle}>{t('historyTitle', language)}</Text>
          {historyItems.length > 0 && (
            <TouchableOpacity
              onPress={handleConfirmClear}
              accessibilityRole="button"
              accessibilityLabel={t('clearAll', language)}
              style={styles.clearBtn}
            >
              <Trash2 size={14} color={colors.danger} strokeWidth={2} />
              <Text style={styles.clearText}>{t('clearAll', language)}</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={styles.headerSubtitle}>
          {t('historySubtitle', language)}
        </Text>
      </View>

      <View style={styles.filterBar}>
        {[
          { key: 'all', label: t('filterAll', language) },
          { key: 'chat', label: t('filterChat', language) },
          { key: 'scan', label: t('filterScans', language) },
          { key: 'classify', label: t('filterClassify', language) },
        ].map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterChip, activeFilter === f.key && styles.activeFilterChip]}
            onPress={() => setActiveFilter(f.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeFilter === f.key }}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFilter === f.key && styles.activeFilterChipText,
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {filteredItems.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Clock size={40} color={colors.textMuted} strokeWidth={1.5} />
            <Text style={styles.emptyTitle}>{t('noHistory', language)}</Text>
            <Text style={styles.emptyText}>
              {t('noHistoryText', language)}
            </Text>
          </View>
        ) : (
          filteredItems.map((item) => {
            const meta = typeMeta(item.type);
            const TypeIcon = meta.icon;
            const dateStr = item.timestamp
              ? new Date(item.timestamp).toLocaleDateString(language === 'hi' ? 'hi-IN' : 'en-IN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';

            return (
              <View key={item.id} style={styles.card}>
                <TouchableOpacity
                  style={styles.cardBody}
                  onPress={() => handleOpenItem(item)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}`}
                >
                  <View style={styles.cardHeader}>
                    <View style={[styles.badge, { backgroundColor: meta.bg }]}>
                      <TypeIcon size={11} color={meta.fg} strokeWidth={2.5} />
                      <Text style={[styles.badgeText, { color: meta.fg }]}>
                        {meta.label}
                      </Text>
                    </View>
                    <Text style={styles.dateText}>{dateStr}</Text>
                  </View>

                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.cardSummary} numberOfLines={2}>
                    {item.summary}
                  </Text>
                </TouchableOpacity>

                <View style={styles.cardFooter}>
                  <TouchableOpacity
                    style={styles.openLinkRow}
                    onPress={() => handleOpenItem(item)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('open', language)}: ${item.title}`}
                  >
                    <Text style={styles.openLink}>{t('open', language)}</Text>
                    <ArrowRight size={13} color={colors.brand} strokeWidth={2.25} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => deleteItem(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel={t('delete', language)}
                  >
                    <Trash2 size={13} color={colors.textMuted} strokeWidth={2} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    padding: spacing.lg,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    ...typography.title,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
  },
  clearText: {
    fontSize: 13,
    color: colors.danger,
    fontWeight: '600',
  },
  headerSubtitle: {
    marginTop: spacing.xs,
    ...typography.subtitle,
  },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.sm,
    backgroundColor: colors.bgMuted,
  },
  activeFilterChip: {
    backgroundColor: colors.brand,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  activeFilterChipText: {
    color: colors.textOnBrand,
    fontWeight: '700',
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  card: {
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    ...shadow.sm,
  },
  cardBody: {
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.sm,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  dateText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  cardSummary: {
    ...typography.bodySmall,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  openLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  openLink: {
    fontSize: 13,
    color: colors.brand,
    fontWeight: '700',
  },
  deleteBtn: {
    padding: spacing.sm,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
    gap: spacing.md,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 20,
  },
});
