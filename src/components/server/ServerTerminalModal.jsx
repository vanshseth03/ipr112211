import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import {
  Terminal,
  Power,
  RefreshCw,
  X,
  Cpu,
  Radio,
  Copy,
  Check,
  AlertCircle,
  Clock,
} from 'lucide-react-native';
import {
  triggerServerStart,
  triggerServerStop,
  fetchServerLogs,
  fetchCloudServerStatus,
} from '../../constants/config';

export default function ServerTerminalModal({ visible, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [serverState, setServerState] = useState({
    status: 'offline',
    ready: false,
    server_url: '',
    kaggle_status: 'UNKNOWN',
  });
  const [copied, setCopied] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const scrollRef = useRef(null);

  // Poll status & logs when visible
  useEffect(() => {
    if (!visible) return;

    loadStatusAndLogs();

    const interval = setInterval(() => {
      if (autoRefresh) {
        loadStatusAndLogs(false);
      }
    }, 3500);

    return () => clearInterval(interval);
  }, [visible, autoRefresh]);

  async function loadStatusAndLogs(showSpinner = true) {
    if (showSpinner) setLoadingLogs(true);
    try {
      const [statusData, logData] = await Promise.all([
        fetchCloudServerStatus(),
        fetchServerLogs(),
      ]);

      if (statusData) {
        setServerState(statusData);
      }
      if (logData?.logs) {
        setLogs(logData.logs);
      }
    } catch (_) {}
    if (showSpinner) setLoadingLogs(false);
  }

  async function handleStart() {
    setActionLoading(true);
    try {
      await triggerServerStart();
      await loadStatusAndLogs(false);
    } catch (_) {}
    setActionLoading(false);
  }

  async function handleStop() {
    setActionLoading(true);
    try {
      await triggerServerStop();
      await loadStatusAndLogs(false);
    } catch (_) {}
    setActionLoading(false);
  }

  function copyUrl() {
    if (!serverState.server_url) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(serverState.server_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const isOnline = serverState.ready && serverState.status === 'running';
  const isBooting = serverState.status === 'booting' || serverState.kaggle_status === 'RUNNING' && !serverState.ready;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.iconBox}>
                <Terminal size={20} color="#10B981" />
              </View>
              <View>
                <Text style={styles.title}>Kaggle Dual T4 Server Console</Text>
                <Text style={styles.subtitle}>On-Demand Legal AI Compute Worker</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <X size={20} color="#94A3B8" />
            </TouchableOpacity>
          </View>

          {/* Status & Stats Bar */}
          <View style={styles.statsBar}>
            <View style={styles.statusBadgeContainer}>
              <View
                style={[
                  styles.statusDot,
                  isOnline
                    ? styles.statusDotOnline
                    : isBooting
                    ? styles.statusDotBooting
                    : styles.statusDotOffline,
                ]}
              />
              <Text style={styles.statusText}>
                {isOnline
                  ? 'ONLINE (Dual Tesla T4)'
                  : isBooting
                  ? 'BOOTING MODELS & TUNNEL'
                  : 'SLEEPING (Zero GPU Cost)'}
              </Text>
            </View>

            <View style={styles.chipRow}>
              <View style={styles.metaChip}>
                <Cpu size={12} color="#60A5FA" style={{ marginRight: 4 }} />
                <Text style={styles.metaChipText}>Gemma 2B + BGE-M3</Text>
              </View>
              <View style={styles.metaChip}>
                <Radio size={12} color="#F59E0B" style={{ marginRight: 4 }} />
                <Text style={styles.metaChipText}>
                  {serverState.kaggle_status || 'IDLE'}
                </Text>
              </View>
            </View>
          </View>

          {/* Active Tunnel URL banner */}
          {serverState.server_url ? (
            <View style={styles.urlBanner}>
              <Text style={styles.urlLabel}>LIVE TUNNEL:</Text>
              <Text style={styles.urlText} numberOfLines={1}>
                {serverState.server_url}
              </Text>
              <TouchableOpacity style={styles.copyBtn} onPress={copyUrl}>
                {copied ? <Check size={14} color="#10B981" /> : <Copy size={14} color="#94A3B8" />}
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Terminal Logs Window */}
          <View style={styles.terminalBox}>
            <View style={styles.terminalHeader}>
              <View style={styles.terminalTrafficLights}>
                <View style={[styles.light, { backgroundColor: '#EF4444' }]} />
                <View style={[styles.light, { backgroundColor: '#F59E0B' }]} />
                <View style={[styles.light, { backgroundColor: '#10B981' }]} />
                <Text style={styles.terminalTitle}>stdout.log</Text>
              </View>

              <View style={styles.terminalActions}>
                <TouchableOpacity
                  style={styles.refreshBtn}
                  onPress={() => loadStatusAndLogs(true)}
                >
                  <RefreshCw size={13} color="#94A3B8" />
                  <Text style={styles.refreshBtnText}>Refresh</Text>
                </TouchableOpacity>
              </View>
            </View>

            <ScrollView
              ref={scrollRef}
              style={styles.logScroll}
              contentContainerStyle={styles.logScrollContent}
              onContentSizeChange={() => {
                if (autoRefresh) {
                  scrollRef.current?.scrollToEnd({ animated: true });
                }
              }}
            >
              {loadingLogs && logs.length === 0 ? (
                <View style={styles.logLoader}>
                  <ActivityIndicator size="small" color="#10B981" />
                  <Text style={styles.loadingLogsText}>Fetching Kaggle output stream...</Text>
                </View>
              ) : logs.length === 0 ? (
                <Text style={styles.emptyLogText}>
                  No worker active. Click "Power On Server" below to start the Dual Tesla T4 instance.
                </Text>
              ) : (
                logs.map((item, idx) => {
                  const text = item.text || '';
                  const isErr = text.includes('ERROR') || text.includes('failed');
                  const isSuccess = text.includes('✓') || text.includes('200 OK') || text.includes('ready') || text.includes('healthy');
                  const isNotice = text.includes('INFO') || text.includes('===') || text.includes('Starting');

                  return (
                    <Text
                      key={idx}
                      style={[
                        styles.logLine,
                        isErr
                          ? styles.logLineError
                          : isSuccess
                          ? styles.logLineSuccess
                          : isNotice
                          ? styles.logLineNotice
                          : styles.logLineDefault,
                      ]}
                    >
                      {text}
                    </Text>
                  );
                })
              )}
            </ScrollView>
          </View>

          {/* Action Bar */}
          <View style={styles.actionBar}>
            {isOnline || isBooting ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.stopBtn]}
                onPress={handleStop}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <>
                    <Power size={16} color="#FFF" style={{ marginRight: 6 }} />
                    <Text style={styles.btnTextWhite}>Stop Server (Save GPU Hours)</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, styles.startBtn]}
                onPress={handleStart}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <>
                    <Power size={16} color="#FFF" style={{ marginRight: 6 }} />
                    <Text style={styles.btnTextWhite}>Power On GPU Server</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  container: {
    width: '100%',
    maxWidth: 780,
    maxHeight: '90%',
    backgroundColor: '#0F172A',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#064E3B',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 12,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#1E293B',
  },
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#1E293B',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusDotOnline: {
    backgroundColor: '#10B981',
  },
  statusDotBooting: {
    backgroundColor: '#F59E0B',
  },
  statusDotOffline: {
    backgroundColor: '#64748B',
  },
  statusText: {
    color: '#F1F5F9',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  metaChipText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '500',
  },
  urlBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E293B',
    paddingHorizontal: 20,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    gap: 8,
  },
  urlLabel: {
    color: '#10B981',
    fontSize: 11,
    fontWeight: '700',
  },
  urlText: {
    flex: 1,
    color: '#93C5FD',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  copyBtn: {
    padding: 4,
  },
  terminalBox: {
    flex: 1,
    minHeight: 320,
    maxHeight: 460,
    backgroundColor: '#020617',
  },
  terminalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#090D16',
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  terminalTrafficLights: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  light: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
  },
  terminalTitle: {
    color: '#64748B',
    fontSize: 11,
    marginLeft: 8,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  terminalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: '#1E293B',
  },
  refreshBtnText: {
    color: '#94A3B8',
    fontSize: 11,
  },
  logScroll: {
    flex: 1,
    padding: 12,
  },
  logScrollContent: {
    paddingBottom: 20,
  },
  logLoader: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: 12,
  },
  loadingLogsText: {
    color: '#94A3B8',
    fontSize: 12,
  },
  emptyLogText: {
    color: '#64748B',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 60,
    fontStyle: 'italic',
  },
  logLine: {
    fontSize: 11,
    lineHeight: 17,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  logLineDefault: {
    color: '#A1A1AA',
  },
  logLineNotice: {
    color: '#38BDF8',
  },
  logLineSuccess: {
    color: '#4ADE80',
  },
  logLineError: {
    color: '#F87171',
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    backgroundColor: '#0F172A',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  startBtn: {
    backgroundColor: '#059669',
  },
  stopBtn: {
    backgroundColor: '#DC2626',
  },
  btnTextWhite: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
