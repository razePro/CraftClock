import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { executeRconCommand, queryMinecraftDaytime, queryMinecraftGametime } from './RconClient';
import { fetchServerTapPlayers } from './ServerTapClient';
import { getServerPowerState, sendPowerAction } from './PterodactylClient';
import SftpNative from './modules/minecraft-sftp';

let ClipboardModule;
let UpdatesModule;
try { ClipboardModule = require('expo-clipboard'); } catch { ClipboardModule = null; }
try { UpdatesModule = require('expo-updates'); } catch { UpdatesModule = null; }
const Clipboard = ClipboardModule?.default || ClipboardModule;
const Updates = UpdatesModule?.default || UpdatesModule;

const STORAGE_KEY = 'minecraft-rcon-settings-v1';
const DEFAULT_SETTINGS = {
  host: '',
  port: '8355',
  password: '',
  autoSync: false,
  panelUrl: '',
  apiKey: '',
  serverId: '',
  sftpHost: '',
  sftpPort: '22',
  sftpUsername: '',
  sftpPassword: '',
  sftpTrustedFingerprint: '',
  sftpTrustedAddress: '',
  serverTapUrl: '',
  serverTapKey: '',
  blueMapUrl: '',
};
const COLORS = {
  background: '#161B26',
  surface: '#1d2432',
  surfaceRaised: '#242d3c',
  border: '#313b4d',
  text: '#f4f6fc',
  muted: '#969faf',
  dim: '#687282',
  accent: '#1F29D8',
  accentBright: '#8992ff',
  green: '#7de2ad',
  red: '#ff969e',
  amber: '#f3c87b',
};

function evaluateTicks(dayTicks, totalDays) {
  let phase;
  if (dayTicks < 12000) phase = { name: 'Daytime', emoji: '☀️', color: '#f3cd72', safe: true };
  else if (dayTicks < 13000) phase = { name: 'Sunset', emoji: '🌇', color: '#f39a68', safe: true };
  else if (dayTicks < 23000) phase = { name: 'Nighttime', emoji: '🌙', color: '#9daeff', safe: false };
  else phase = { name: 'Sunrise', emoji: '🌅', color: '#eaa37f', safe: false };
  return { totalDays, dayTicks, phase };
}

function getNextPhaseCountdown(dayTicks) {
  let phase;
  let targetTicks;
  if (dayTicks < 12000) { phase = 'Sunset'; targetTicks = 12000; }
  else if (dayTicks < 13000) { phase = 'Night'; targetTicks = 13000; }
  else if (dayTicks < 23000) { phase = 'Sunrise'; targetTicks = 23000; }
  else { phase = 'Day'; targetTicks = 24000; }
  return { phase, seconds: Math.floor((targetTicks - dayTicks) / 20) };
}

function formatCountdown(seconds) {
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
  const ss = (seconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Not synced yet';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatPlayerActivity(player) {
  const raw = Number(player.lastPlayed);
  if (!Number.isFinite(raw) || raw <= 0) return player.online ? 'Online' : 'Last seen time unavailable';
  const timestamp = raw < 1e12 ? raw * 1000 : raw;
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  let duration;
  if (days > 0) duration = `${days}d ${hours}h`;
  else if (hours > 0) duration = `${hours}h ${remainingMinutes}m`;
  else if (minutes > 0) duration = `${minutes}m`;
  else duration = 'less than a minute';
  return player.online ? `Online for ${duration}` : `Last seen ${duration} ago`;
}

function playerDisplayName(player) {
  return String(player.displayName || player.name || player.uuid || 'Unknown player');
}

function Field({ label, value, onChangeText, placeholder, keyboardType = 'default', secureTextEntry = false, autoCapitalize = 'none', multiline = false, right }) {
  return (
    <View style={styles.fieldGroup}>
      <View style={styles.fieldHeader}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {right}
      </View>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.dim}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        style={[styles.input, multiline && styles.multilineInput]}
      />
    </View>
  );
}

function ActionButton({ title, icon, onPress, variant = 'primary', disabled = false, loading = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.actionButton, styles[`button_${variant}`], pressed && !disabled && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={[styles.actionIcon, styles[`buttonText_${variant}`]]}>{loading ? '◌' : icon}</Text>
      <Text style={[styles.actionText, styles[`buttonText_${variant}`]]}>{loading ? 'Working…' : title}</Text>
    </Pressable>
  );
}

function TabButton({ label, icon, selected, onPress, useLiquidGlass }) {
  const IconSurface = useLiquidGlass ? GlassView : View;
  return (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected }} onPress={onPress} style={styles.tabButton}>
      <IconSurface
        style={[styles.tabIconWrap, selected && styles.tabIconWrapSelected]}
        {...(useLiquidGlass ? {
          glassEffectStyle: { style: selected ? 'regular' : 'none', animate: true, animationDuration: 0.28 },
          isInteractive: selected,
          tintColor: selected ? 'rgba(145, 160, 255, 0.24)' : undefined,
        } : {})}
      >
        <Text style={[styles.tabIcon, selected && styles.tabIconSelected]}>{icon}</Text>
      </IconSurface>
      <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{label}</Text>
      {selected ? <View style={styles.tabIndicator} /> : null}
    </Pressable>
  );
}

function BottomTabBar({ activeTab, onSelect }) {
  const insets = useSafeAreaInsets();
  const useLiquidGlass = Platform.OS === 'ios' && isGlassEffectAPIAvailable();
  return (
    <View style={[styles.tabBarDock, { paddingBottom: Platform.OS === 'ios' ? Math.max(0, insets.bottom - 8) : 10 }]}>
      <View style={styles.tabBar}>
        {useLiquidGlass ? (
          <GlassView pointerEvents="none" style={styles.tabBarGlass} glassEffectStyle="regular" tintColor="rgba(28, 34, 48, 0.28)" />
        ) : null}
        <TabButton label="Dashboard" icon="◷" selected={activeTab === 'dashboard'} onPress={() => onSelect('dashboard')} useLiquidGlass={useLiquidGlass} />
        <TabButton label="Console" icon="›_" selected={activeTab === 'console'} onPress={() => onSelect('console')} useLiquidGlass={useLiquidGlass} />
        <TabButton label="Settings" icon="⚙" selected={activeTab === 'settings'} onPress={() => onSelect('settings')} useLiquidGlass={useLiquidGlass} />
      </View>
    </View>
  );
}

function SectionHeading({ title, trailing }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {trailing ? <Text style={styles.sectionTrailing}>{trailing}</Text> : null}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [result, setResult] = useState(null);
  const [resultUpdatedAt, setResultUpdatedAt] = useState(null);
  const [countdownNow, setCountdownNow] = useState(Date.now());
  const [ticksInput, setTicksInput] = useState('');
  const [calcError, setCalcError] = useState('');
  const [lastSynced, setLastSynced] = useState(null);
  const [autoSync, setAutoSync] = useState(false);
  const [isForeground, setIsForeground] = useState(true);
  const [rconBusy, setRconBusy] = useState(false);
  const [rconMessage, setRconMessage] = useState('');
  const [powerState, setPowerState] = useState('unknown');
  const [powerError, setPowerError] = useState('');
  const [powerBusy, setPowerBusy] = useState(false);
  const [consoleCommand, setConsoleCommand] = useState('');
  const [consoleBusy, setConsoleBusy] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const [consoleView, setConsoleView] = useState('terminal');
  const [players, setPlayers] = useState([]);
  const [playersBusy, setPlayersBusy] = useState(false);
  const [playersError, setPlayersError] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showRconPassword, setShowRconPassword] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showSftpPassword, setShowSftpPassword] = useState(false);
  const [showSftpBrowser, setShowSftpBrowser] = useState(false);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpMessage, setSftpMessage] = useState('');
  const [sftpPath, setSftpPath] = useState('/');
  const [sftpEntries, setSftpEntries] = useState([]);
  const [copyMessage, setCopyMessage] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [previewHost, setPreviewHost] = useState('');
  const [previewMessage, setPreviewMessage] = useState('');
  const [showBlueMap, setShowBlueMap] = useState(false);
  const [mapOverhead, setMapOverhead] = useState(false);
  const mapWebView = useRef(null);
  const pageMotion = useRef(new Animated.Value(0)).current;
  const cycleProgress = useRef(new Animated.Value(0)).current;
  const pageScroll = useRef(null);
  const consoleScroll = useRef(null);
  const rconBusyRef = useRef(false);
  const powerPollBusyRef = useRef(false);
  const playersBusyRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((stored) => {
        if (!mounted) return;
        if (stored) {
          const saved = JSON.parse(stored);
          setSettings({ ...DEFAULT_SETTINGS, ...saved });
          setAutoSync(Boolean(saved.autoSync));
          setIsSaved(true);
        }
      })
      .catch(() => setSettingsMessage('Saved settings could not be loaded. Save them again in Settings.'))
      .finally(() => { if (mounted) setSettingsLoaded(true); });
    const subscription = AppState.addEventListener('change', (state) => setIsForeground(state === 'active'));
    return () => { mounted = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
      if (activeTab === 'console') {
        setTimeout(() => pageScroll.current?.scrollToEnd({ animated: true }), 80);
      }
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [activeTab]);

  useEffect(() => {
    pageMotion.setValue(0);
    const animation = Animated.timing(pageMotion, { toValue: 1, duration: 320, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [activeTab, pageMotion]);

  const syncClock = useCallback(async () => {
    if (rconBusyRef.current) return;
    rconBusyRef.current = true;
    setRconBusy(true);
    setRconMessage('Syncing the world clock…');
    try {
      const connection = { host: settings.host.trim(), port: Number(settings.port), password: settings.password };
      const daytimeTicks = await queryMinecraftDaytime(connection);
      const gametime = await queryMinecraftGametime(connection);
      const timestamp = Date.now();
      setTicksInput(String(gametime));
      setResult(evaluateTicks(daytimeTicks, Math.floor(gametime / 24000)));
      setResultUpdatedAt(timestamp);
      setCountdownNow(timestamp);
      setLastSynced(timestamp);
      setRconMessage(`Synced from server at ${formatTimestamp(timestamp)}.`);
    } catch (error) {
      setRconMessage(error?.message || 'Could not reach the RCON server. Check the connection settings.');
    } finally {
      rconBusyRef.current = false;
      setRconBusy(false);
    }
  }, [settings.host, settings.password, settings.port]);

  const refreshPlayers = useCallback(async () => {
    if (playersBusyRef.current) return;
    playersBusyRef.current = true;
    setPlayersBusy(true);
    setPlayersError('');
    try {
      const nextPlayers = await fetchServerTapPlayers({
        serverTapUrl: settings.serverTapUrl,
        serverTapKey: settings.serverTapKey,
      });
      setPlayers(nextPlayers);
    } catch (error) {
      setPlayersError(error?.message || 'Could not load players from ServerTap.');
    } finally {
      playersBusyRef.current = false;
      setPlayersBusy(false);
    }
  }, [settings.serverTapKey, settings.serverTapUrl]);

  useEffect(() => {
    if (activeTab === 'dashboard' && settingsLoaded && isSaved) refreshPlayers();
  }, [activeTab, isSaved, refreshPlayers, settingsLoaded]);

  function sendMapKey(key, pressed) {
    const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ '+': 187, '-': 189, ArrowUp: 38, ArrowDown: 40 }[key] || 0);
    const type = pressed ? 'keydown' : 'keyup';
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyExpression = JSON.stringify(key);
    mapWebView.current?.injectJavaScript(`(function(){var init={key:${keyExpression},code:${JSON.stringify(code)},keyCode:${keyCode},which:${keyCode},bubbles:true,cancelable:true};document.dispatchEvent(new KeyboardEvent('${type}',init));window.dispatchEvent(new KeyboardEvent('${type}',init));})();true;`);
  }

  function zoomMap(direction) {
    const action = direction > 0 ? 'in' : 'out';
    mapWebView.current?.injectJavaScript(`(function(){var selectors=${JSON.stringify(direction > 0 ? ['.bm-zoom-in', '.zoom-in', '[aria-label="Zoom in"]', 'button[title*="Zoom in"]'] : ['.bm-zoom-out', '.zoom-out', '[aria-label="Zoom out"]', 'button[title*="Zoom out"]'])};var button=null;for(var i=0;i<selectors.length&&!button;i++)button=document.querySelector(selectors[i]);if(button){button.click();return;}var candidates=[...document.querySelectorAll('button,[role="button"]')];var match=candidates.find(function(b){var t=((b.getAttribute('aria-label')||'')+' '+(b.title||'')+' '+(b.textContent||'')).toLowerCase();return t.includes('zoom')&&t.includes('${action}');});if(match){match.click();return;}var target=document.querySelector('#map-container,canvas')||document.body;target.dispatchEvent(new WheelEvent('wheel',{deltaY:${direction > 0 ? -240 : 240},deltaMode:0,bubbles:true,cancelable:true,view:window}));})();true;`);
  }

  function toggleMapView() {
    const nextOverhead = !mapOverhead;
    setMapOverhead(nextOverhead);
    const topDown = nextOverhead;
    mapWebView.current?.injectJavaScript(`(function(){var names=${JSON.stringify(topDown ? ['top', 'overhead', '2d', 'flat'] : ['perspective', '3d', 'isometric', 'free'])};var buttons=[...document.querySelectorAll('button,[role="button"],a')];var b=buttons.find(function(x){var t=((x.getAttribute('aria-label')||'')+' '+(x.title||'')+' '+(x.textContent||'')).toLowerCase();return names.some(function(n){return t.includes(n);});});if(b){b.click();return;}var vm=window.blueMap||window.bluemap||window.map;var viewer=vm&&(vm.mapViewer||vm.viewer||vm);var camera=viewer&&(viewer.camera||viewer.mapCamera);if(camera){var controls=viewer.controls||vm.controls;if(controls&&controls.setMode){controls.setMode(${topDown ? "'top-down'" : "'perspective'"});return;}if(camera.position&&camera.position.set){var p=camera.position;camera.position.set(p.x,${topDown ? 'Math.max(p.y,1200)' : '120'},p.z);camera.rotation.x=${topDown ? '-Math.PI/2' : '-Math.PI/4'};camera.updateProjectionMatrix&&camera.updateProjectionMatrix();}}})();true;`);
  }

  function mapControlButton(label, key, options = {}) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} onPressIn={() => sendMapKey(key, true)} onPressOut={() => sendMapKey(key, false)} style={styles.mapDpadButton}><Text style={[styles.mapDpadText, options.small && styles.mapSmallText]}>{label}</Text></Pressable>;
  }

  const refreshPowerState = useCallback(async () => {
    if (!settings.panelUrl.trim() || !settings.apiKey.trim() || !settings.serverId.trim() || powerPollBusyRef.current) return;
    powerPollBusyRef.current = true;
    try {
      const state = await getServerPowerState(settings);
      setPowerState(state);
      setPowerError('');
    } catch (error) {
      setPowerError(error?.message || 'Could not read the Pterodactyl server status.');
    } finally {
      powerPollBusyRef.current = false;
    }
  }, [settings]);

  useEffect(() => {
    if (!settingsLoaded || !isSaved || !autoSync || !isForeground || activeTab !== 'dashboard') return undefined;
    const timer = setInterval(syncClock, 5000);
    return () => clearInterval(timer);
  }, [activeTab, autoSync, isForeground, isSaved, settingsLoaded, syncClock]);

  useEffect(() => {
    const hasPanel = settingsLoaded && isSaved && settings.panelUrl.trim() && settings.apiKey.trim() && settings.serverId.trim();
    if (!hasPanel || !isForeground || activeTab !== 'dashboard') return undefined;
    refreshPowerState();
    const timer = setInterval(refreshPowerState, 10000);
    return () => clearInterval(timer);
  }, [activeTab, isForeground, isSaved, refreshPowerState, settings.apiKey, settings.panelUrl, settings.serverId, settingsLoaded]);

  useEffect(() => {
    if (!result) return undefined;
    const timer = setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [result]);

  const elapsedTicks = result && resultUpdatedAt ? Math.floor(Math.max(0, countdownNow - resultUpdatedAt) / 50) : 0;
  const liveDayTicks = result ? (result.dayTicks + elapsedTicks) % 24000 : 0;
  const phaseCountdown = result ? getNextPhaseCountdown(liveDayTicks) : null;
  const progressPercent = (liveDayTicks / 24000) * 100;

  useEffect(() => {
    Animated.spring(cycleProgress, { toValue: progressPercent, damping: 18, stiffness: 100, mass: 0.8, useNativeDriver: false }).start();
  }, [cycleProgress, progressPercent]);

  const cycleWidth = cycleProgress.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  const serverStateLabel = useMemo(() => ({
    running: 'Running', offline: 'Offline', starting: 'Starting', stopping: 'Stopping',
    restarting: 'Restarting', unknown: 'Not connected',
  }[powerState] || powerState[0]?.toUpperCase() + powerState.slice(1)), [powerState]);
  const serverStateColor = powerState === 'running' ? COLORS.green : powerState === 'offline' ? COLORS.red : powerState === 'unknown' ? COLORS.muted : COLORS.amber;
  const pterodactylReady = Boolean(settings.panelUrl.trim() && settings.apiKey.trim() && settings.serverId.trim());

  function setSetting(key, value) {
    setSettings((previous) => ({ ...previous, [key]: value }));
    setSettingsMessage('');
  }

  async function saveSettings() {
    Keyboard.dismiss();
    const port = Number(settings.port);
    const sftpPort = Number(settings.sftpPort || 22);
    if (!settings.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || !settings.password) {
      setSettingsMessage('Enter an RCON host, valid port, and password.');
      return;
    }
    if (!Number.isInteger(sftpPort) || sftpPort < 1 || sftpPort > 65535) {
      setSettingsMessage('Enter a valid SFTP port.');
      return;
    }
    const next = { ...settings, host: settings.host.trim(), port: String(port), sftpPort: String(sftpPort), autoSync };
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
      setSettings(next);
      setIsSaved(true);
      setSettingsMessage('Settings saved securely on this iPhone.');
    } catch {
      setSettingsMessage('Could not securely save settings. Please try again.');
    }
  }

  async function changeAutoSync(enabled) {
    setAutoSync(enabled);
    const next = { ...settings, autoSync: enabled };
    setSettings(next);
    if (isSaved) {
      try { await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next)); }
      catch { setSettingsMessage('Auto-sync changed for this session but could not be saved.'); }
    }
    if (enabled) syncClock();
  }

  function calculateTicks() {
    Keyboard.dismiss();
    const raw = ticksInput.trim();
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      setCalcError('Enter a valid whole number of server ticks.');
      setResult(null);
      return;
    }
    const now = Date.now();
    const totalTicks = Number(raw);
    setResult(evaluateTicks(totalTicks % 24000, Math.floor(totalTicks / 24000)));
    setResultUpdatedAt(now);
    setCountdownNow(now);
    setCalcError('');
  }

  async function runPowerAction(signal) {
    setPowerBusy(true);
    setPowerError('');
    if (signal === 'start') setPowerState('starting');
    else if (signal === 'restart') setPowerState('restarting');
    else setPowerState('stopping');
    try {
      await sendPowerAction(settings, signal);
      setPowerError(`${signal[0].toUpperCase()}${signal.slice(1)} request sent.`);
      setTimeout(refreshPowerState, 2500);
    } catch (error) {
      setPowerError(error?.message || 'The power action could not be sent.');
      refreshPowerState();
    } finally {
      setPowerBusy(false);
    }
  }

  function confirmPower(signal) {
    const titles = { start: 'Start server?', restart: 'Restart server?', stop: 'Stop server?', kill: 'Force kill server?' };
    const messages = {
      start: 'Send a start request to your Pterodactyl server?',
      restart: 'Restart the Minecraft server? Players may be disconnected.',
      stop: 'Send a graceful stop request? The server can save and shut down cleanly.',
      kill: 'Forcefully terminate the server process? Unsaved world changes may be lost.',
    };
    Alert.alert(titles[signal], messages[signal], [
      { text: 'Cancel', style: 'cancel' },
      { text: signal === 'kill' ? 'Kill server' : signal[0].toUpperCase() + signal.slice(1), style: signal === 'stop' || signal === 'kill' ? 'destructive' : 'default', onPress: () => runPowerAction(signal) },
    ]);
  }

  function chooseStopOrKill() {
    Alert.alert('Stop server', 'Choose a graceful stop or a force kill.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop gracefully', style: 'destructive', onPress: () => confirmPower('stop') },
      { text: 'Force kill…', style: 'destructive', onPress: () => confirmPower('kill') },
    ]);
  }

  function appendConsoleLine(line) {
    setConsoleLines((previous) => [...previous, { ...line, id: `${Date.now()}-${Math.random()}` }].slice(-150));
  }

  async function sendConsoleCommand() {
    const command = consoleCommand.trim();
    if (!command || consoleBusy) return;
    Keyboard.dismiss();
    setConsoleCommand('');
    appendConsoleLine({ type: 'command', text: command, time: formatTimestamp(Date.now()) });
    setConsoleBusy(true);
    try {
      const response = await executeRconCommand({ host: settings.host.trim(), port: Number(settings.port), password: settings.password, command });
      appendConsoleLine({ type: 'response', text: response || '(Command completed with no response)', time: formatTimestamp(Date.now()) });
    } catch (error) {
      appendConsoleLine({ type: 'error', text: error?.message || 'The command failed.', time: formatTimestamp(Date.now()) });
    } finally {
      setConsoleBusy(false);
    }
  }

  async function copyValue(label, value) {
    if (!value.trim()) {
      setCopyMessage(`Add your SFTP ${label.toLowerCase()} in Settings first.`);
      return;
    }
    if (typeof Clipboard?.setStringAsync !== 'function') {
      setCopyMessage('Clipboard support needs the updated IPA. You can still preview the rest of the Settings screen.');
      return;
    }
    try {
      await Clipboard.setStringAsync(value);
      setCopyMessage(`${label} copied.`);
    } catch {
      setCopyMessage('Could not copy to clipboard.');
    }
  }

  function getSftpHost() {
    return settings.sftpHost.trim().replace(/^sftp:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function requireSftpModule() {
    if (Platform.OS !== 'ios') throw new Error('The in-app SFTP client is currently available in the iOS app.');
    if (!SftpNative || typeof SftpNative.getHostFingerprint !== 'function') {
      throw new Error('SFTP needs the updated standalone iOS app. Expo Go and the previous IPA do not include the native SFTP module.');
    }
    const host = getSftpHost();
    const port = Number(settings.sftpPort || 22);
    if (!host || !settings.sftpUsername.trim() || !settings.sftpPassword) {
      throw new Error('Enter the SFTP host, port, username, and password in Settings, then save your settings.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid SFTP port in Settings.');
    if (!isSaved) throw new Error('Save your SFTP connection details before connecting.');
    return { host, port, username: settings.sftpUsername.trim(), password: settings.sftpPassword };
  }

  async function getTrustedSftpFingerprint(connection) {
    const address = `${connection.host}:${connection.port}`;
    const presented = await SftpNative.getHostFingerprint(connection.host, connection.port, connection.username);
    if (!presented) throw new Error('The server did not provide an SSH host fingerprint. Connection refused.');
    const alreadyTrusted = settings.sftpTrustedAddress === address && settings.sftpTrustedFingerprint?.toLowerCase() === presented.toLowerCase();
    if (alreadyTrusted) return presented;

    const changed = settings.sftpTrustedAddress === address && Boolean(settings.sftpTrustedFingerprint);
    const accepted = await new Promise((resolve) => Alert.alert(
      changed ? 'SFTP host key changed' : 'Trust this SFTP server?',
      `${changed ? 'The saved SSH fingerprint no longer matches. Only continue if you expected the server key to change.\n\n' : 'Confirm this fingerprint with your hosting provider before trusting it.\n\n'}${presented}`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: changed ? 'Trust new key' : 'Trust server', style: changed ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    ));
    if (!accepted) throw new Error('SFTP connection cancelled because the host key was not trusted.');
    const next = { ...settings, sftpTrustedAddress: address, sftpTrustedFingerprint: presented };
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    setSettings(next);
    setIsSaved(true);
    return presented;
  }

  async function loadSftpDirectory(path = sftpPath) {
    let connection;
    try { connection = requireSftpModule(); }
    catch (error) { setSftpMessage(error.message); return; }
    setSftpBusy(true);
    setSftpMessage('Connecting securely…');
    try {
      const fingerprint = await getTrustedSftpFingerprint(connection);
      const entries = await SftpNative.listDirectory(connection.host, connection.port, connection.username, connection.password, fingerprint, path);
      setSftpEntries(entries);
      setSftpPath(path);
      setSftpMessage(`${entries.length} item${entries.length === 1 ? '' : 's'} · SSH fingerprint verified`);
    } catch (error) {
      setSftpMessage(error?.message || 'Could not read this folder.');
    } finally {
      setSftpBusy(false);
    }
  }

  async function openSftpBrowser() {
    setShowSftpBrowser(true);
    await loadSftpDirectory('/');
  }

  function parentSftpPath(path) {
    if (!path || path === '/') return '/';
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
  }

  function joinSftpPath(parent, name) {
    const safeName = name.trim().replace(/^\/+|\/+$/g, '');
    if (!safeName || safeName === '.' || safeName === '..') return parent;
    return `${parent === '/' ? '' : parent}/${safeName}` || '/';
  }

  async function createSftpFolder(name) {
    const clean = name.trim();
    if (!clean || clean.includes('/') || clean === '.' || clean === '..' || clean.includes('\\')) { setSftpMessage('Enter a valid folder name without path separators.'); return; }
    try {
      const connection = requireSftpModule();
      const fingerprint = await getTrustedSftpFingerprint(connection);
      await SftpNative.createDirectory(connection.host, connection.port, connection.username, connection.password, fingerprint, joinSftpPath(sftpPath, clean));
      await loadSftpDirectory(sftpPath);
    } catch (error) { setSftpMessage(error?.message || 'Could not create the folder.'); }
  }

  function promptCreateSftpFolder() {
    Alert.prompt('New folder', 'Choose a name for the remote folder.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Create', onPress: (name) => createSftpFolder(name || '') },
    ], 'plain-text');
  }

  async function renameSftpEntry(entry, oldPath, newName) {
    const clean = (newName || '').trim();
    if (!clean || clean.includes('/') || clean === '.' || clean === '..' || clean.includes('\\')) { setSftpMessage('Enter a valid name without path separators.'); return; }
    try {
      const connection = requireSftpModule();
      const fingerprint = await getTrustedSftpFingerprint(connection);
      await SftpNative.rename(connection.host, connection.port, connection.username, connection.password, fingerprint, oldPath, joinSftpPath(sftpPath, clean));
      await loadSftpDirectory(sftpPath);
    } catch (error) { setSftpMessage(error?.message || `Could not rename ${entry.name}.`); }
  }

  async function deleteSftpEntry(entry, remotePath) {
    setSftpBusy(true);
    try {
      const connection = requireSftpModule();
      const fingerprint = await getTrustedSftpFingerprint(connection);
      await SftpNative.delete(connection.host, connection.port, connection.username, connection.password, fingerprint, remotePath, Boolean(entry.isDirectory));
      await loadSftpDirectory(sftpPath);
    } catch (error) { setSftpMessage(error?.message || `Could not delete ${entry.name}.`); }
    finally { setSftpBusy(false); }
  }

  function showSftpEntryActions(entry) {
    const remotePath = joinSftpPath(sftpPath, entry.name);
    const actions = [];
    if (entry.isDirectory) {
      actions.push({ text: 'Open folder', onPress: () => loadSftpDirectory(remotePath) });
    } else {
      actions.push({ text: 'Download / share', onPress: () => downloadSftpFile(entry, remotePath) });
    }
    actions.push({ text: 'Rename', onPress: () => Alert.prompt('Rename item', 'Enter the new name.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Rename', onPress: (name) => renameSftpEntry(entry, remotePath, name || '') },
    ], 'plain-text', entry.name) });
    actions.push({ text: 'Delete…', style: 'destructive', onPress: () => Alert.alert('Delete item?', `Delete ${entry.name} from the server?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteSftpEntry(entry, remotePath) },
    ]) });
    actions.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(entry.name, entry.isDirectory ? 'Remote folder' : 'Remote file', actions);
  }

  async function downloadSftpFile(entry, remotePath) {
    setSftpBusy(true);
    setSftpMessage(`Downloading ${entry.name}…`);
    try {
      const connection = requireSftpModule();
      const fingerprint = await getTrustedSftpFingerprint(connection);
      const localUri = await SftpNative.download(connection.host, connection.port, connection.username, connection.password, fingerprint, remotePath, entry.name);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(localUri, { dialogTitle: `Save or share ${entry.name}` });
      else setSftpMessage(`Downloaded to the app’s temporary files: ${entry.name}`);
    } catch (error) { setSftpMessage(error?.message || `Could not download ${entry.name}.`); }
    finally { setSftpBusy(false); }
  }

  async function uploadSftpFile() {
    try {
      requireSftpModule();
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const connection = requireSftpModule();
      const fingerprint = await getTrustedSftpFingerprint(connection);
      setSftpBusy(true);
      setSftpMessage(`Uploading ${asset.name}…`);
      await SftpNative.upload(connection.host, connection.port, connection.username, connection.password, fingerprint, asset.uri, joinSftpPath(sftpPath, asset.name));
      await loadSftpDirectory(sftpPath);
    } catch (error) { setSftpMessage(error?.message || 'Could not upload this file.'); }
    finally { setSftpBusy(false); }
  }

  async function checkForUpdates() {
    if (__DEV__ || !Updates?.isEnabled || typeof Updates.checkForUpdateAsync !== 'function') {
      setUpdateMessage('OTA update checks need the updated standalone IPA. You can still preview the Settings screen in this build.');
      return;
    }
    setUpdateBusy(true);
    setUpdateMessage('Checking for an update…');
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setUpdateMessage('You already have the latest version.');
        return;
      }
      setUpdateMessage('Update found. Downloading…');
      const fetched = await Updates.fetchUpdateAsync();
      if (fetched.isNew) {
        setUpdateMessage('Update downloaded. Restarting the app…');
        await Updates.reloadAsync();
        return;
      }
      setUpdateMessage('The update could not be installed. Please try again.');
    } catch (error) {
      setUpdateMessage(error?.message || 'Could not check for updates. Check your internet connection and try again.');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function connectToPcPreview() {
    const host = previewHost.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!host || /\s/.test(host)) {
      setPreviewMessage('Enter your PC’s local IP address, for example 192.168.1.19.');
      return;
    }
    try {
      const url = `exp+minecraft-time-calculator://expo-development-client/?url=${encodeURIComponent(`http://${host}:8081`)}`;
      await Linking.openURL(url);
    } catch {
      setPreviewMessage('PC Preview opens only in the development IPA. Start the PC server and use the development build.');
    }
  }

  const pageTranslate = pageMotion.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });
  const settingsPage = activeTab === 'settings';
  const consolePage = activeTab === 'console';
  const mapUrl = settings.blueMapUrl.trim();

  return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'left']}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          key={activeTab}
          ref={pageScroll}
          contentContainerStyle={[styles.scrollContent, consolePage && styles.consoleScroll]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={{ opacity: pageMotion, transform: [{ translateY: pageTranslate }] }}>
            {!settingsPage && !consolePage ? (
              <>
                <View style={styles.header}>
                  <Text style={styles.eyebrow}>MINECRAFT SERVER</Text>
                  <Text style={styles.title}>World clock</Text>
                  <Text style={styles.subtitle}>Your world’s time, power and cycle at a glance.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="WORLD TIME" trailing={result ? 'LIVE DATA' : 'READY'} />
                  {result ? (
                    <>
                      <Text style={styles.resultLabel}>TOTAL DAYS PASSED</Text>
                      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.days}>{result.totalDays.toLocaleString()}</Text>
                      <View style={styles.resultDivider} />
                      <View style={styles.tickStatusRow}>
                        <View>
                          <Text style={styles.resultLabel}>CURRENT DAYTIME TICKS</Text>
                          <Text style={styles.ticks}>{Math.floor(liveDayTicks).toLocaleString()}</Text>
                        </View>
                        <View style={[styles.phaseBadge, result.phase.safe ? styles.safeBadge : styles.hostileBadge]}>
                          <Text style={styles.phaseBadgeText}>{result.phase.emoji} {result.phase.name}</Text>
                        </View>
                      </View>
                    </>
                  ) : (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyIcon}>☾</Text>
                      <Text style={styles.emptyTitle}>World time is waiting</Text>
                      <Text style={styles.emptyCopy}>Sync from RCON or enter a tick count below.</Text>
                    </View>
                  )}
                  <View style={styles.cycleCard}>
                    <View style={styles.cycleHeading}>
                      <Text style={styles.cycleTitle}>24,000-TICK DAY CYCLE</Text>
                      <Text style={[styles.cyclePhase, { color: result?.phase.color || COLORS.muted }]}>{result ? `${result.phase.emoji} ${result.phase.name.toUpperCase()}` : 'WAITING'}</Text>
                    </View>
                    <View style={styles.cycleTrack}>
                      <View style={[styles.cycleSegment, { flex: 12, backgroundColor: '#d3ab4a' }]} />
                      <View style={[styles.cycleSegment, { flex: 1, backgroundColor: '#d87552' }]} />
                      <View style={[styles.cycleSegment, { flex: 10, backgroundColor: '#59689a' }]} />
                      <View style={[styles.cycleSegment, { flex: 1, backgroundColor: '#a86f61' }]} />
                      <Animated.View style={[styles.cycleFill, { width: cycleWidth }]} />
                      {result ? <Animated.View style={[styles.cycleMarker, { left: cycleWidth }]} /> : null}
                    </View>
                    <View style={styles.cycleNumbers}>
                      <Text style={styles.cycleTick}>{result ? `${Math.floor(liveDayTicks).toLocaleString()} ticks` : '— ticks'}</Text>
                      <Text style={styles.cyclePercent}>{result ? `${progressPercent.toFixed(1)}%` : '—'}</Text>
                    </View>
                    <View style={styles.countdownRow} accessibilityLiveRegion="polite">
                      <Text style={styles.countdownCaption}>{phaseCountdown ? `Next: ${phaseCountdown.phase} in` : 'NEXT PHASE IN'}</Text>
                      <Text style={styles.countdownTime}>{phaseCountdown ? formatCountdown(phaseCountdown.seconds) : '--:--'}</Text>
                    </View>
                    <View style={styles.cycleLegend}>
                      <Text style={styles.legendDay}>Day 0–12k</Text><Text style={styles.legendSunset}>Sunset 12–13k</Text>
                      <Text style={styles.legendNight}>Night 13–23k</Text><Text style={styles.legendSunrise}>Sunrise 23–24k</Text>
                    </View>
                  </View>
                  <View style={styles.clockActions}>
                    <ActionButton title="Sync from RCON" icon="↻" onPress={syncClock} variant="primary" disabled={rconBusy} loading={rconBusy} />
                    <Text style={styles.mutedCenter}>{autoSync ? 'Live Auto-Sync · every 5 seconds' : `Last sync · ${formatTimestamp(lastSynced)}`}</Text>
                    {rconMessage ? <Text style={[styles.feedback, rconMessage.startsWith('Synced') && styles.goodFeedback]}>{rconMessage}</Text> : null}
                  </View>
                  <View style={styles.manualBlock}>
                    <Text style={styles.fieldLabel}>OR ENTER SERVER TICKS</Text>
                    <TextInput
                      accessibilityLabel="Server ticks"
                      value={ticksInput}
                      onChangeText={(value) => { setTicksInput(value); setCalcError(''); }}
                      placeholder="e.g. 22002600"
                      placeholderTextColor={COLORS.dim}
                      keyboardType="number-pad"
                      inputMode="numeric"
                      maxLength={16}
                      style={styles.input}
                    />
                    <ActionButton title="Calculate ticks" icon="↗" onPress={calculateTicks} variant="secondary" />
                    {calcError ? <Text style={styles.errorText}>{calcError}</Text> : null}
                  </View>
                </View>

                <View style={[styles.consoleCard, styles.playersCard]}>
                  <View style={styles.playersToolbar}>
                    <View><Text style={styles.playersHeading}>PLAYER ROSTER</Text><Text style={styles.playersSubheading}>{players.length} player{players.length === 1 ? '' : 's'} · online first</Text></View>
                    <Pressable accessibilityRole="button" onPress={refreshPlayers} disabled={playersBusy} style={[styles.playersRefresh, playersBusy && styles.disabled]}><Text style={styles.playersRefreshText}>{playersBusy ? 'Loading…' : 'Refresh ↻'}</Text></Pressable>
                  </View>
                  {playersError ? <Text style={styles.playersError}>{playersError}</Text> : null}
                  <FlatList
                    style={styles.playersList}
                    data={players}
                    keyExtractor={(item, index) => String(item.uuid || item.name || item.displayName || index)}
                    refreshing={playersBusy}
                    onRefresh={refreshPlayers}
                    scrollEnabled={false}
                    contentContainerStyle={styles.playersListContent}
                    ListEmptyComponent={<Text style={styles.playersEmpty}>{playersBusy ? 'Loading players…' : 'No players found. Pull down to refresh.'}</Text>}
                    renderItem={({ item }) => { const name = playerDisplayName(item); return <View style={[styles.playerRow, !item.online && styles.playerRowOffline]}><Image source={{ uri: `https://minotar.net/helm/${encodeURIComponent(name)}/100.png` }} style={styles.playerAvatar} /><View style={styles.playerDetails}><Text numberOfLines={1} style={[styles.playerName, !item.online && styles.playerNameOffline]}>{name}</Text><Text style={styles.playerActivity}>{formatPlayerActivity(item)}</Text></View><View style={[styles.playerStatusDot, item.online ? styles.playerStatusOnline : styles.playerStatusOffline]} /></View>; }}
                  />
                </View>

                <View style={styles.card}>
                  <SectionHeading title="BLUEMAP" trailing="LIVE WORLD" />
                  <Text style={styles.updateDescription}>Explore your Minecraft world in 3D and navigate the camera with the on-screen controls.</Text>
                  <ActionButton title="Open Live Map" icon="⌖" onPress={() => setShowBlueMap(true)} variant="primary" disabled={!mapUrl} />
                  {!mapUrl ? <Text style={styles.mutedSmall}>Add a BlueMap URL in Settings to open the live map.</Text> : null}
                </View>
              </>
            ) : consolePage ? (
              <>
                {!keyboardVisible ? <View style={styles.header}>
                  <Text style={styles.eyebrow}>SERVER TOOLS</Text>
                  <Text style={styles.title}>Infrastructure</Text>
                  <Text style={styles.subtitle}>Manage server power and run live RCON commands.</Text>
                </View> : null}
                <View style={[styles.card, styles.powerCard]}>
                  <SectionHeading title="SERVER POWER" trailing="PTERODACTYL" />
                  <View style={styles.powerStateRow}>
                    <View style={[styles.stateDot, { backgroundColor: serverStateColor }]} />
                    <Text style={[styles.powerStateText, { color: serverStateColor }]}>{serverStateLabel}</Text>
                    <Pressable accessibilityRole="button" onPress={refreshPowerState} style={styles.refreshButton}><Text style={styles.refreshText}>Refresh ↻</Text></Pressable>
                  </View>
                  <View style={styles.powerButtons}>
                    <ActionButton title="Start" icon="▶" onPress={() => confirmPower('start')} variant="start" disabled={powerBusy || !pterodactylReady} loading={powerBusy} />
                    <ActionButton title="Restart" icon="↻" onPress={() => confirmPower('restart')} variant="restart" disabled={powerBusy || !pterodactylReady} />
                    <ActionButton title="Stop / Kill" icon="■" onPress={chooseStopOrKill} variant="stop" disabled={powerBusy || !pterodactylReady} />
                  </View>
                  {powerError ? <Text style={[styles.feedback, powerError.includes('request sent') && styles.goodFeedback]}>{powerError}</Text> : null}
                  {!settings.panelUrl || !settings.apiKey || !settings.serverId ? <Text style={styles.mutedSmall}>Add Panel URL, API key and Server ID in Settings to enable power controls.</Text> : null}
                </View>
                {!keyboardVisible ? <View style={styles.sectionHeader}><Text style={styles.eyebrow}>REMOTE CONSOLE</Text><Text style={styles.sectionSubtitle}>Watch command responses and server output here.</Text></View> : null}
                <View style={[styles.consoleCard, keyboardVisible && styles.consoleCardKeyboard]}>
                  <View style={styles.consoleTopBar}>
                    <View style={styles.consoleDotRow}><View style={styles.consoleDot} /><View style={[styles.consoleDot, styles.consoleDotAmber]} /><View style={[styles.consoleDot, styles.consoleDotGreen]} /></View>
                    <Text style={styles.consoleHeading}>LIVE RCON</Text>
                    <Text style={styles.consoleCount}>{consoleLines.length} lines</Text>
                  </View>
                  <ScrollView
                    ref={consoleScroll}
                    style={styles.consoleLog}
                    contentContainerStyle={styles.consoleLogContent}
                    onContentSizeChange={() => consoleScroll.current?.scrollToEnd({ animated: true })}
                    keyboardShouldPersistTaps="handled"
                  >
                    {consoleLines.length === 0 ? (
                      <View style={styles.consoleEmpty}>
                        <Text style={styles.consolePrompt}>$</Text>
                        <Text style={styles.consoleEmptyText}>No commands yet. Try “list” or “time query daytime”.</Text>
                      </View>
                    ) : consoleLines.map((line) => (
                      <View key={line.id} style={styles.consoleLine}>
                        <Text style={styles.consoleTime}>{line.time}</Text>
                        <Text selectable style={[styles.consoleLineText, line.type === 'command' && styles.consoleCommand, line.type === 'error' && styles.consoleError]}>
                          {line.type === 'command' ? `› ${line.text}` : line.type === 'error' ? `! ${line.text}` : line.text}
                        </Text>
                      </View>
                    ))}
                    {consoleBusy ? <Text style={styles.consoleWorking}>Waiting for server response…</Text> : null}
                  </ScrollView>
                  <View style={styles.consoleInputRow}>
                    <TextInput
                      accessibilityLabel="RCON command"
                      value={consoleCommand}
                      onChangeText={setConsoleCommand}
                      onSubmitEditing={sendConsoleCommand}
                      placeholder="Enter a server command…"
                      placeholderTextColor={COLORS.dim}
                      returnKeyType="send"
                      autoCapitalize="none"
                      autoCorrect={false}
                      onFocus={() => setTimeout(() => pageScroll.current?.scrollToEnd({ animated: true }), 250)}
                      style={[styles.input, styles.consoleInput]}
                    />
                    <Pressable accessibilityRole="button" accessibilityLabel="Send RCON command" onPress={sendConsoleCommand} disabled={consoleBusy || !consoleCommand.trim()} style={[styles.sendButton, (consoleBusy || !consoleCommand.trim()) && styles.disabled]}>
                      <Text style={styles.sendButtonText}>{consoleBusy ? '…' : 'Send'}</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.consoleSafety}>RCON is unencrypted TCP. Commands execute with your server’s RCON permissions.</Text>
                </View>
              </>
            ) : showSftpBrowser ? (
              <>
                <View style={styles.header}>
                  <Pressable accessibilityRole="button" onPress={() => setShowSftpBrowser(false)} style={styles.backButton}><Text style={styles.backButtonText}>‹  Settings</Text></Pressable>
                  <Text style={styles.eyebrow}>SECURE FILE TRANSFER</Text>
                  <Text style={styles.title}>Server files</Text>
                  <Text style={styles.subtitle}>{getSftpHost() || 'Add SFTP details in Settings'} · port {settings.sftpPort || '22'}</Text>
                </View>
                <View style={styles.card}>
                  <View style={styles.fileToolbar}>
                    <Pressable accessibilityRole="button" onPress={() => loadSftpDirectory(parentSftpPath(sftpPath))} disabled={sftpBusy || sftpPath === '/'} style={[styles.fileToolbarButton, sftpPath === '/' && styles.disabled]}><Text style={styles.fileToolbarText}>↑ Up</Text></Pressable>
                    <Text numberOfLines={1} style={styles.filePath}>{sftpPath}</Text>
                    <Pressable accessibilityRole="button" onPress={() => loadSftpDirectory(sftpPath)} disabled={sftpBusy} style={styles.fileToolbarButton}><Text style={styles.fileToolbarText}>↻</Text></Pressable>
                  </View>
                  <View style={styles.fileActions}>
                    <Pressable accessibilityRole="button" onPress={promptCreateSftpFolder} disabled={sftpBusy} style={styles.fileActionButton}><Text style={styles.fileActionText}>＋ Folder</Text></Pressable>
                    <Pressable accessibilityRole="button" onPress={uploadSftpFile} disabled={sftpBusy} style={styles.fileActionButton}><Text style={styles.fileActionText}>↑ Upload file</Text></Pressable>
                  </View>
                  {sftpBusy ? <Text style={styles.feedback}>{sftpMessage || 'Working…'}</Text> : null}
                  {!sftpBusy && sftpMessage ? <Text style={[styles.feedback, sftpEntries.length > 0 && styles.goodFeedback]}>{sftpMessage}</Text> : null}
                  {!sftpBusy && sftpEntries.length === 0 ? <Text style={styles.fileEmpty}>This folder is empty, or it has not been loaded yet.</Text> : null}
                  {sftpEntries.map((entry) => (
                    <Pressable
                      key={`${sftpPath}/${entry.name}`}
                      accessibilityRole="button"
                      onPress={() => entry.isDirectory ? loadSftpDirectory(joinSftpPath(sftpPath, entry.name)) : showSftpEntryActions(entry)}
                      onLongPress={() => showSftpEntryActions(entry)}
                      style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
                    >
                      <Text style={styles.fileIcon}>{entry.isDirectory ? '▰' : '▤'}</Text>
                      <View style={styles.fileCopy}>
                        <Text numberOfLines={1} style={styles.fileName}>{entry.name}</Text>
                        <Text style={styles.fileMeta}>{entry.isDirectory ? 'Folder' : `${Number(entry.size || 0).toLocaleString()} bytes`}{entry.modified ? ` · ${new Date(entry.modified).toLocaleDateString()}` : ''}</Text>
                      </View>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Options for ${entry.name}`} onPress={() => showSftpEntryActions(entry)} style={styles.fileMore}><Text style={styles.fileMoreText}>•••</Text></Pressable>
                    </Pressable>
                  ))}
                  <Text style={styles.securityHint}>SSH host key pinning is enabled. Files are transferred over SFTP; keep this saved password private.</Text>
                </View>
              </>
            ) : (
              <>
                <View style={styles.header}>
                  <Text style={styles.eyebrow}>PREFERENCES</Text>
                  <Text style={styles.title}>Settings</Text>
                  <Text style={styles.subtitle}>Connection credentials are encrypted in iOS Keychain.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="RCON CONNECTION" trailing="ENCRYPTED" />
                  <Field label="SERVER IP / HOST" value={settings.host} onChangeText={(value) => setSetting('host', value)} placeholder="minecraft.example.com" keyboardType="url" />
                  <Field label="RCON PORT" value={settings.port} onChangeText={(value) => setSetting('port', value)} placeholder="8355" keyboardType="number-pad" />
                  <Field label="RCON PASSWORD" value={settings.password} onChangeText={(value) => setSetting('password', value)} placeholder="RCON password" secureTextEntry={!showRconPassword} right={<Pressable onPress={() => setShowRconPassword((show) => !show)}><Text style={styles.revealText}>{showRconPassword ? 'Hide' : 'Show'}</Text></Pressable>} />
                  <View style={styles.switchRow}>
                    <View style={styles.switchCopy}><Text style={styles.switchTitle}>Live Auto-Sync</Text><Text style={styles.switchSubtitle}>Query the server every 5 seconds while Dashboard is open.</Text></View>
                    <Switch value={autoSync} onValueChange={changeAutoSync} trackColor={{ false: '#303744', true: '#6878e7' }} thumbColor={autoSync ? '#f4f6fc' : '#afb7c4'} />
                  </View>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="PTERODACTYL CLIENT API" trailing="POWER + STATUS" />
                  <Field label="PANEL URL" value={settings.panelUrl} onChangeText={(value) => setSetting('panelUrl', value)} placeholder="https://panel.example.com" keyboardType="url" />
                  <Field label="CLIENT API KEY" value={settings.apiKey} onChangeText={(value) => setSetting('apiKey', value)} placeholder="ptlc_…" secureTextEntry={!showApiKey} right={<Pressable onPress={() => setShowApiKey((show) => !show)}><Text style={styles.revealText}>{showApiKey ? 'Hide' : 'Show'}</Text></Pressable>} />
                  <Field label="SERVER ID / IDENTIFIER" value={settings.serverId} onChangeText={(value) => setSetting('serverId', value)} placeholder="Server identifier from the Panel" autoCapitalize="none" />
                  <Text style={styles.securityHint}>Use a Client API key with permission to view resources and send power commands. Use HTTPS so the key is encrypted in transit.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="SERVERTAP PLAYER API" trailing="PLAYER ROSTER" />
                  <Field label="SERVERTAP API URL" value={settings.serverTapUrl} onChangeText={(value) => setSetting('serverTapUrl', value)} placeholder="https://server.example.com:4567" keyboardType="url" />
                  <Field label="SERVERTAP KEY" value={settings.serverTapKey} onChangeText={(value) => setSetting('serverTapKey', value)} placeholder="Optional if key auth is disabled" secureTextEntry />
                  <Text style={styles.securityHint}>The key is sent in ServerTap’s key request header. Settings are stored in iOS Keychain.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="BLUEMAP" trailing="LIVE WORLD" />
                  <Field label="BLUEMAP URL" value={settings.blueMapUrl} onChangeText={(value) => setSetting('blueMapUrl', value)} placeholder="http://server.example.com:8100" keyboardType="url" />
                  <Text style={styles.securityHint}>Enter the BlueMap web address, including any required path.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="SFTP CONNECTION" trailing="ENCRYPTED" />
                  <Field label="SFTP HOST" value={settings.sftpHost} onChangeText={(value) => setSetting('sftpHost', value)} placeholder="sftp.example.com" keyboardType="url" />
                  <Field label="SFTP PORT" value={settings.sftpPort} onChangeText={(value) => setSetting('sftpPort', value)} placeholder="2022" keyboardType="number-pad" />
                  <Field label="SFTP USERNAME" value={settings.sftpUsername} onChangeText={(value) => setSetting('sftpUsername', value)} placeholder="username" />
                  <Field label="SFTP PASSWORD" value={settings.sftpPassword} onChangeText={(value) => setSetting('sftpPassword', value)} placeholder="SFTP password" secureTextEntry={!showSftpPassword} right={<Pressable onPress={() => setShowSftpPassword((show) => !show)}><Text style={styles.revealText}>{showSftpPassword ? 'Hide' : 'Show'}</Text></Pressable>} />
                  <View style={styles.copyRow}>
                    <Pressable accessibilityRole="button" onPress={() => copyValue('Host', settings.sftpHost)} style={styles.copyButton}><Text style={styles.copyText}>Copy Host</Text></Pressable>
                    <Pressable accessibilityRole="button" onPress={() => copyValue('Port', settings.sftpPort)} style={styles.copyButton}><Text style={styles.copyText}>Copy Port</Text></Pressable>
                    <Pressable accessibilityRole="button" onPress={() => copyValue('Username', settings.sftpUsername)} style={styles.copyButton}><Text style={styles.copyText}>Copy User</Text></Pressable>
                  </View>
                  {copyMessage ? <Text style={styles.feedback}>{copyMessage}</Text> : null}
                  <ActionButton title="Browse server files" icon="↗" onPress={openSftpBrowser} variant="secondary" />
                  <Text style={styles.securityHint}>Credentials are saved in iOS Keychain. First connection shows the SSH fingerprint; confirm it with your hosting provider before trusting the server.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="OVER-THE-AIR UPDATES" trailing="EAS UPDATE" />
                  <Text style={styles.updateDescription}>Check Expo’s update channel for JavaScript and asset updates, download a compatible update, then restart into it. Native module changes still need a new IPA.</Text>
                  <ActionButton title="Check for Updates" icon="↻" onPress={checkForUpdates} variant="primary" disabled={updateBusy} loading={updateBusy} />
                  {updateMessage ? <Text style={styles.feedback}>{updateMessage}</Text> : null}
                  <Text style={styles.securityHint}>Updates must be published to this build’s EAS channel. See the project’s update instructions.</Text>
                </View>

                <View style={styles.card}>
                  <SectionHeading title="PC DEVELOPMENT PREVIEW" trailing="DEVELOPMENT IPA" />
                  <Text style={styles.updateDescription}>For live local code preview, run the PC server on the same Wi-Fi and connect with the development IPA.</Text>
                  <Field label="PC IP ADDRESS" value={previewHost} onChangeText={setPreviewHost} placeholder="e.g. 192.168.1.19" keyboardType="url" />
                  <ActionButton title="Connect to PC Preview" icon="↗" onPress={connectToPcPreview} variant="secondary" />
                  {previewMessage ? <Text style={styles.feedback}>{previewMessage}</Text> : null}
                </View>

                {settingsMessage ? <Text style={[styles.settingsMessage, settingsMessage.startsWith('Settings saved') && styles.goodFeedback]}>{settingsMessage}</Text> : null}
                <ActionButton title={isSaved ? 'Save settings' : 'Save settings securely'} icon="✓" onPress={saveSettings} variant="primary" />
                <Text style={styles.settingsFooter}>Minecraft day = 24,000 ticks · Game time advances at 20 ticks per second</Text>
              </>
            )}
          </Animated.View>
        </ScrollView>

        <Modal visible={showBlueMap} animationType="slide" presentationStyle="fullScreen" supportedOrientations={['portrait', 'landscape']} statusBarTranslucent onRequestClose={() => setShowBlueMap(false)}>
          <View style={[styles.mapModal, { paddingTop: Platform.OS === 'ios' ? 0 : insets.top }]}>
            <WebView
              ref={mapWebView}
              source={{ uri: mapUrl }}
              style={styles.mapWebView}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              startInLoadingState={true}
              mixedContentMode="always"
              originWhitelist={['*']}
              injectedJavaScript={`(function(){var s=document.createElement('style');s.textContent='html,body,#map-container{width:100%!important;height:100%!important;margin:0!important}.bm-map{top:env(safe-area-inset-top,28px)!important}';document.head.appendChild(s);document.documentElement.style.setProperty('--safe-area-inset-top','28px');})();true;`}
              allowsBackForwardNavigationGestures
            />
              <View pointerEvents="box-none" style={[styles.mapHud, { paddingTop: Math.max(insets.top, 10) + 8, paddingBottom: Math.max(insets.bottom, 10) + 16 }]}>
              <View pointerEvents="box-none" style={styles.mapHudHeader}><View pointerEvents="none" style={styles.mapHudTitleWrap}><Text style={styles.mapHudTitle}>BLUEMAP · CAMERA</Text></View><Pressable accessibilityRole="button" onPress={() => setShowBlueMap(false)} style={styles.mapCloseButton}><Text style={styles.mapCloseText}>Close Map</Text></Pressable></View>
              <View pointerEvents="box-none" style={[styles.mapControlsCorner, windowDimensions.width > windowDimensions.height ? styles.mapControlsLandscape : null]}>
                <View style={styles.mapDpad}>
                  <View style={styles.mapDpadRow}><View style={styles.mapDpadSpacer} />{mapControlButton('▲', 'w', { small: true })}<View style={styles.mapDpadSpacer} /></View>
                  <View style={styles.mapDpadRow}>{mapControlButton('◀', 'a', { small: true })}{mapControlButton('▼', 's', { small: true })}{mapControlButton('▶', 'd', { small: true })}</View>
                </View>
                <View style={styles.mapExtraControls}>
                  <View style={styles.mapControlRow}><Pressable accessibilityRole="button" accessibilityLabel="Zoom in" onPress={() => zoomMap(1)} style={styles.mapDpadButton}><Text style={styles.mapDpadText}>＋</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Zoom out" onPress={() => zoomMap(-1)} style={styles.mapDpadButton}><Text style={styles.mapDpadText}>−</Text></Pressable></View>
                  <Pressable accessibilityRole="button" accessibilityLabel="Toggle 3D and overhead view" onPress={toggleMapView} style={styles.mapModeButton}><Text style={styles.mapModeText}>{mapOverhead ? 'Overhead' : '3D / Overhead'}</Text></Pressable>
                </View>
              </View>
            </View>
          </View>
        </Modal>

        {!(consolePage && keyboardVisible) ? <BottomTabBar activeTab={activeTab} onSelect={setActiveTab} /> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  scrollContent: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 28 },
  consoleScroll: { flex: 1 },
  header: { marginBottom: 20 },
  sectionHeader: { marginTop: 2, marginBottom: 12 },
  sectionSubtitle: { color: COLORS.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  eyebrow: { color: COLORS.accentBright, fontSize: 10, fontWeight: '900', letterSpacing: 2.2, marginBottom: 8 },
  title: { color: COLORS.text, fontSize: 33, lineHeight: 40, fontWeight: '800', letterSpacing: -1.1 },
  subtitle: { color: COLORS.muted, fontSize: 14, lineHeight: 21, marginTop: 4 },
  card: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderWidth: 1, borderRadius: 22, padding: 17, marginBottom: 14 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 17 },
  sectionLabel: { color: '#a4adbc', fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  sectionTrailing: { color: COLORS.dim, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  resultLabel: { color: '#929cab', fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  days: { color: COLORS.text, fontSize: 56, lineHeight: 63, fontWeight: '900', letterSpacing: -2, marginTop: 2 },
  resultDivider: { height: 1, backgroundColor: '#2a323f', marginVertical: 13 },
  tickStatusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ticks: { color: COLORS.text, fontSize: 27, lineHeight: 34, fontWeight: '800', marginTop: 4 },
  phaseBadge: { borderRadius: 20, paddingHorizontal: 11, paddingVertical: 8 },
  safeBadge: { backgroundColor: '#183729' },
  hostileBadge: { backgroundColor: '#322d49' },
  phaseBadgeText: { color: COLORS.text, fontSize: 10, fontWeight: '800' },
  emptyState: { alignItems: 'center', paddingVertical: 15, paddingHorizontal: 12 },
  emptyIcon: { color: COLORS.accentBright, fontSize: 40, marginBottom: 8 },
  emptyTitle: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  emptyCopy: { color: COLORS.muted, fontSize: 11, textAlign: 'center', marginTop: 5 },
  cycleCard: { borderTopWidth: 1, borderTopColor: '#2a323f', marginTop: 16, paddingTop: 14 },
  cycleHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 },
  cycleTitle: { color: '#a4adbc', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  cyclePhase: { fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  cycleTrack: { height: 12, flexDirection: 'row', overflow: 'hidden', borderRadius: 8, position: 'relative', backgroundColor: '#29313f' },
  cycleSegment: { height: '100%' },
  cycleFill: { position: 'absolute', top: 0, left: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.16)' },
  cycleMarker: { position: 'absolute', top: -1, bottom: -1, width: 2, marginLeft: -1, backgroundColor: '#fff' },
  cycleNumbers: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  cycleTick: { color: '#aeb6c2', fontSize: 9, fontWeight: '700' },
  cyclePercent: { color: '#d2d8e5', fontSize: 9, fontWeight: '800' },
  countdownRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: 12, backgroundColor: '#202735', paddingHorizontal: 12, paddingVertical: 9, marginTop: 10 },
  countdownCaption: { color: '#c3cada', fontSize: 10, fontWeight: '700' },
  countdownTime: { color: COLORS.accentBright, fontSize: 17, fontWeight: '900', fontVariant: ['tabular-nums'] },
  cycleLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  legendDay: { color: '#e4c66c', fontSize: 7 },
  legendSunset: { color: '#e3946d', fontSize: 7 },
  legendNight: { color: '#9daeff', fontSize: 7 },
  legendSunrise: { color: '#eaa37f', fontSize: 7 },
  clockActions: { marginTop: 14 },
  actionButton: { minHeight: 45, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  button_primary: { backgroundColor: COLORS.accent },
  button_secondary: { backgroundColor: '#202735', borderWidth: 1, borderColor: '#414b5e' },
  button_start: { backgroundColor: '#19392b', borderWidth: 1, borderColor: '#28553e' },
  button_restart: { backgroundColor: '#282e43', borderWidth: 1, borderColor: '#424c73' },
  button_stop: { backgroundColor: '#3b2229', borderWidth: 1, borderColor: '#67323b' },
  actionIcon: { fontSize: 15, fontWeight: '900', marginRight: 8 },
  actionText: { fontSize: 12, fontWeight: '900' },
  buttonText_primary: { color: '#ffffff' },
  buttonText_secondary: { color: '#d9deff' },
  buttonText_start: { color: COLORS.green },
  buttonText_restart: { color: COLORS.accentBright },
  buttonText_stop: { color: COLORS.red },
  pressed: { opacity: 0.8, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.55 },
  mutedCenter: { color: COLORS.dim, fontSize: 9, textAlign: 'center', marginTop: 8 },
  feedback: { color: COLORS.amber, fontSize: 10, lineHeight: 15, marginTop: 9 },
  goodFeedback: { color: COLORS.green },
  manualBlock: { borderTopWidth: 1, borderTopColor: '#2a323f', marginTop: 14, paddingTop: 13 },
  fieldGroup: { marginBottom: 13 },
  fieldHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  fieldLabel: { color: '#9aa3b1', fontSize: 8, fontWeight: '900', letterSpacing: 1.25 },
  input: { minHeight: 46, borderRadius: 12, borderColor: '#343d4b', borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, color: COLORS.text, backgroundColor: '#0d1118', fontSize: 14 },
  multilineInput: { minHeight: 76, textAlignVertical: 'top' },
  revealText: { color: COLORS.accentBright, fontSize: 10, fontWeight: '800' },
  errorText: { color: COLORS.red, fontSize: 10, marginTop: 8 },
  powerCard: { marginTop: 0 },
  powerStateRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 13 },
  stateDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  powerStateText: { fontSize: 14, fontWeight: '800', flex: 1 },
  refreshButton: { padding: 5 },
  refreshText: { color: COLORS.accentBright, fontSize: 10, fontWeight: '700' },
  powerButtons: { flexDirection: 'row', gap: 7 },
  mutedSmall: { color: COLORS.dim, fontSize: 9, lineHeight: 14, marginTop: 9 },
  consoleCard: { flex: 1, minHeight: 420, backgroundColor: '#10151c', borderColor: '#28313d', borderWidth: 1, borderRadius: 18, overflow: 'hidden' },
  consoleCardKeyboard: { minHeight: 240 },
  consoleTopBar: { height: 43, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, backgroundColor: '#1a202a', borderBottomWidth: 1, borderBottomColor: '#29313f' },
  consoleDotRow: { flexDirection: 'row', gap: 5, width: 56 },
  consoleDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#f07373' },
  consoleDotAmber: { backgroundColor: '#e8bb67' },
  consoleDotGreen: { backgroundColor: '#68c48e' },
  consoleHeading: { color: '#cdd4e1', fontSize: 8, fontWeight: '900', letterSpacing: 1.3, flex: 1, textAlign: 'center' },
  consoleCount: { color: COLORS.dim, fontSize: 8, width: 56, textAlign: 'right' },
  consoleLog: { flex: 1, maxHeight: 390 },
  consoleLogContent: { padding: 13, flexGrow: 1 },
  consoleEmpty: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', paddingTop: 8 },
  consolePrompt: { color: COLORS.green, fontSize: 13, fontWeight: '900', marginRight: 9 },
  consoleEmptyText: { color: COLORS.dim, fontSize: 11, lineHeight: 18, flex: 1 },
  consoleLine: { marginBottom: 12 },
  consoleTime: { color: '#657184', fontSize: 8, marginBottom: 3 },
  consoleLineText: { color: '#d6deea', fontSize: 11, lineHeight: 17, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  consoleCommand: { color: COLORS.accentBright },
  consoleError: { color: COLORS.red },
  consoleWorking: { color: COLORS.amber, fontSize: 10, marginTop: 5 },
  consoleInputRow: { flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: '#29313f', backgroundColor: '#171d26' },
  consoleInput: { flex: 1, minHeight: 43, fontSize: 12 },
  sendButton: { width: 62, minHeight: 43, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.accent },
  sendButtonText: { color: '#111727', fontSize: 11, fontWeight: '900' },
  consoleSafety: { color: '#8993a2', fontSize: 8, lineHeight: 12, paddingHorizontal: 12, paddingBottom: 11 },
  consoleSegmented: { flexDirection: 'row', padding: 3, borderRadius: 14, backgroundColor: '#151b25', borderWidth: 1, borderColor: '#29313f', marginBottom: 12 },
  consoleSegment: { flex: 1, minHeight: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  consoleSegmentSelected: { backgroundColor: '#272f42', borderWidth: 1, borderColor: '#414b61' },
  consoleSegmentText: { color: COLORS.dim, fontSize: 11, fontWeight: '700' },
  consoleSegmentTextSelected: { color: COLORS.text },
  playersCard: { minHeight: 420 },
  playersToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 13, borderBottomWidth: 1, borderBottomColor: '#29313f', backgroundColor: '#171d26' },
  playersHeading: { color: '#cdd4e1', fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  playersSubheading: { color: COLORS.dim, fontSize: 9, marginTop: 4 },
  playersRefresh: { minHeight: 34, paddingHorizontal: 11, borderRadius: 10, justifyContent: 'center', backgroundColor: '#252d3c' },
  playersRefreshText: { color: COLORS.accentBright, fontSize: 10, fontWeight: '800' },
  playersError: { color: COLORS.red, fontSize: 10, lineHeight: 15, paddingHorizontal: 13, paddingTop: 10 },
  playersList: { flex: 1 },
  playersListContent: { flexGrow: 1, padding: 10 },
  playersEmpty: { color: COLORS.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', padding: 24 },
  playerRow: { flexDirection: 'row', alignItems: 'center', padding: 10, minHeight: 67, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.045)' },
  playerRowOffline: { opacity: 0.58 },
  playerAvatar: { width: 43, height: 43, borderRadius: 11, borderWidth: 1, borderColor: '#3b465a', backgroundColor: '#0d1118' },
  playerDetails: { flex: 1, marginLeft: 11 },
  playerName: { color: COLORS.text, fontSize: 12, fontWeight: '800' },
  playerNameOffline: { color: '#a0a8b5' },
  playerActivity: { color: COLORS.muted, fontSize: 9, marginTop: 4 },
  playerStatusDot: { width: 9, height: 9, borderRadius: 5, marginLeft: 10 },
  playerStatusOnline: { backgroundColor: '#62dc99', shadowColor: '#43e78b', shadowOpacity: 0.85, shadowRadius: 7, shadowOffset: { width: 0, height: 0 }, elevation: 4 },
  playerStatusOffline: { backgroundColor: '#687282' },
  switchRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#2a323f', paddingTop: 13, marginTop: 1 },
  switchCopy: { flex: 1, paddingRight: 10 },
  switchTitle: { color: COLORS.text, fontSize: 11, fontWeight: '800' },
  switchSubtitle: { color: COLORS.dim, fontSize: 9, lineHeight: 13, marginTop: 3 },
  securityHint: { color: '#8993a2', fontSize: 9, lineHeight: 14, marginTop: 2 },
  backButton: { alignSelf: 'flex-start', paddingVertical: 5, paddingRight: 12, marginBottom: 12 },
  backButtonText: { color: COLORS.accentBright, fontSize: 13, fontWeight: '800' },
  fileToolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#2a323f' },
  fileToolbarButton: { minWidth: 46, minHeight: 34, borderRadius: 9, justifyContent: 'center', alignItems: 'center', backgroundColor: '#252d3c', paddingHorizontal: 8 },
  fileToolbarText: { color: COLORS.accentBright, fontSize: 11, fontWeight: '800' },
  filePath: { flex: 1, color: COLORS.text, fontSize: 11, fontWeight: '700' },
  fileActions: { flexDirection: 'row', gap: 8, paddingVertical: 12 },
  fileActionButton: { flex: 1, minHeight: 40, borderRadius: 11, justifyContent: 'center', alignItems: 'center', backgroundColor: '#202735', borderWidth: 1, borderColor: '#394354' },
  fileActionText: { color: COLORS.accentBright, fontSize: 11, fontWeight: '800' },
  fileEmpty: { color: COLORS.muted, fontSize: 11, textAlign: 'center', paddingVertical: 26 },
  fileRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#252d39', paddingVertical: 8 },
  fileIcon: { color: COLORS.accentBright, fontSize: 17, width: 34, textAlign: 'center' },
  fileCopy: { flex: 1, paddingRight: 6 },
  fileName: { color: COLORS.text, fontSize: 12, fontWeight: '800' },
  fileMeta: { color: COLORS.dim, fontSize: 9, marginTop: 4 },
  fileMore: { width: 37, height: 38, alignItems: 'center', justifyContent: 'center' },
  fileMoreText: { color: COLORS.muted, fontSize: 14, fontWeight: '900' },
  copyRow: { flexDirection: 'row', gap: 7, marginTop: 1, marginBottom: 11 },
  copyButton: { flex: 1, minHeight: 35, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: '#202735', borderWidth: 1, borderColor: '#394354' },
  copyText: { color: COLORS.accentBright, fontSize: 9, fontWeight: '800' },
  updateDescription: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: -4, marginBottom: 12 },
  settingsMessage: { color: COLORS.amber, fontSize: 10, lineHeight: 15, marginBottom: 10 },
  settingsFooter: { color: COLORS.dim, fontSize: 9, lineHeight: 14, textAlign: 'center', marginVertical: 14 },
  tabBarDock: { paddingHorizontal: 12, paddingTop: 7, backgroundColor: 'transparent' },
  tabBar: { position: 'relative', flexDirection: 'row', overflow: 'hidden', backgroundColor: 'rgba(31, 38, 54, 0.94)', borderWidth: 1, borderColor: 'rgba(226, 232, 255, 0.2)', borderRadius: 25, paddingTop: 7, paddingHorizontal: 10, shadowColor: COLORS.accent, shadowOpacity: 0.22, shadowRadius: 18, shadowOffset: { width: 0, height: 3 }, elevation: 12 },
  tabBarGlass: { ...StyleSheet.absoluteFillObject, borderRadius: 25 },
  tabButton: { flex: 1, minHeight: 53, alignItems: 'center', justifyContent: 'center' },
  tabIconWrap: { width: 39, height: 29, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  tabIconWrapSelected: { backgroundColor: 'rgba(145, 160, 255, 0.2)', borderColor: 'rgba(190, 199, 255, 0.32)', shadowColor: '#8798ff', shadowOpacity: 0.3, shadowRadius: 9, shadowOffset: { width: 0, height: 1 } },
  tabIcon: { color: '#75808f', fontSize: 17, fontWeight: '700' },
  tabIconSelected: { color: COLORS.accentBright },
  tabLabel: { color: '#75808f', fontSize: 8, fontWeight: '700', marginTop: 3 },
  tabLabelSelected: { color: COLORS.accentBright },
  tabIndicator: { position: 'absolute', top: -7, width: 20, height: 2, borderRadius: 2, backgroundColor: COLORS.accentBright },
  mapModal: { flex: 1, backgroundColor: '#000' },
  mapWebView: { flex: 1, backgroundColor: '#000' },
  mapHud: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', paddingHorizontal: 14 },
  mapHudHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mapHudTitleWrap: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(14,18,28,0.52)' },
  mapHudTitle: { color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  mapCloseButton: { backgroundColor: COLORS.accent, borderRadius: 12, paddingHorizontal: 15, paddingVertical: 11 },
  mapCloseText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  mapControlsCorner: { position: 'absolute', bottom: 30, left: 20, flexDirection: 'row', alignItems: 'flex-end', gap: 8, maxWidth: '100%', padding: 6, borderRadius: 16, backgroundColor: 'rgba(22, 27, 38, 0.48)' },
  mapControlsLandscape: { bottom: 10, left: 14 },
  mapDpad: { alignSelf: 'flex-start', gap: 4, padding: 2, borderRadius: 14, backgroundColor: 'transparent' },
  mapDpadRow: { flexDirection: 'row', justifyContent: 'center', gap: 5 },
  mapDpadSpacer: { width: 43, height: 43 },
  mapDpadButton: { minWidth: 43, height: 43, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: 'rgba(31, 41, 216, 0.66)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  mapDpadText: { color: '#fff', fontSize: 18, fontWeight: '900' },
  mapSmallText: { fontSize: 10 },
  mapExtraControls: { gap: 5, alignItems: 'stretch' },
  mapControlRow: { flexDirection: 'row', gap: 5 },
  mapModeButton: { minHeight: 36, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: 'rgba(31, 41, 216, 0.66)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  mapModeText: { color: '#fff', fontSize: 10, fontWeight: '900' },
});
