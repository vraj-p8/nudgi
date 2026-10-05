'use strict';

// Nudgi — main process.
// Owns the config store, the scheduler, a hidden always-on-top transparent overlay window that the buddy walks
// across, the settings window, the tray icon and the global summon hotkey. Runs are queued and shown one at a time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
} = require('electron');

const D = require('./defaults');
const { Store, sanitizeReminder, cleanText, isId, isInside } = require('./store');
const { Scheduler, TIMING, startOfTomorrow } = require('./scheduler');
const { createTray } = require('./tray');
const { validateModel } = require('./avatar-model');

// ---------------------------------------------------------------------------------------------------------------
// Paths, flags, logging

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const PAGES = {
  overlay: path.join(RENDERER_DIR, 'overlay', 'overlay.html'),
  settings: path.join(RENDERER_DIR, 'settings', 'settings.html'),
};
const ASSETS = path.join(ROOT, 'assets');
const APP_ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

const PRIORITY = { preview: 0, user: 1, auto: 2 }; // previews jump the queue; scheduled runs wait for the gap
const RESPONSES = ['yes', 'later', 'timeout', 'dismiss'];
const EXIT_GRACE_MS = 30 * 1000; // after an answer only the exit animation is left
const CAPTURE_EVERY_MS = 700;
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const THEMES = {
  light: { background: '#F6F8FC', symbols: '#10213A' },
  dark: { background: '#0B1220', symbols: '#E6EEF8' },
};

const log = {
  info: (...a) => console.log('[nudge]', ...a),
  warn: (...a) => console.warn('[nudge]', ...a),
  error: (...a) => console.error('[nudge]', ...a),
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** --demo · --welcome · --settings · --summon · --capture=<dir> */
function parseFlags(argv) {
  const flags = { demo: false, welcome: false, settings: false, summon: false, background: false, capture: null };
  for (const arg of argv.slice(1)) {
    if (arg === '--background') flags.background = true;
    else if (arg === '--demo') flags.demo = true;
    else if (arg === '--welcome') flags.welcome = true;
    else if (arg === '--settings') flags.settings = true;
    else if (arg === '--summon') flags.summon = true;
    else if (arg.startsWith('--capture=')) {
      const dir = arg.slice('--capture='.length).replace(/^"(.*)"$/, '$1');
      if (dir) flags.capture = path.resolve(dir);
    }
  }
  return flags;
}

const flags = parseFlags(process.argv);

// Keep the established profile and Windows identity across the Nudgi rename.
app.setName('Nudgi');
app.setPath('userData', path.join(app.getPath('appData'), 'Nudge Buddy'));

// Test isolation: NUDGE_USER_DATA=<absolute dir> (must happen before the single-instance lock, which is per dir).
const userDataOverride = process.env.NUDGE_USER_DATA;
if (userDataOverride) {
  if (path.isAbsolute(userDataOverride)) {
    fs.mkdirSync(userDataOverride, { recursive: true });
    app.setPath('userData', userDataOverride);
  } else {
    log.warn('NUDGE_USER_DATA must be an absolute path; ignoring it');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// State

let store = null;
let scheduler = null;
let tray = null;
let overlay = null; // { win, ready, clickThrough, unresponsiveTimer, loadAttempts }
let settings = null; // { win, ready }
let quitting = false;
let overlayCrashes = [];
let broadcastPending = false;

const runs = { visible: null, queue: [], lastEndedAt: 0, gapTimer: null };
const hotkey = { accel: null, ok: false };
const capture = { timer: null, frame: 0, busy: false };

function publicState() {
  const d = store.data;
  const laterStreak = {};
  for (const r of d.reminders) {
    const n = scheduler.streakFor(r.id);
    if (n) laterStreak[r.id] = n;
  }
  return {
    settings: d.settings,
    reminders: d.reminders,
    templates: D.TEMPLATES,
    stats: d.stats,
    runtime: { pausedUntil: d.runtime.pausedUntil, next: d.runtime.next, laterStreak, onboarded: d.runtime.onboarded },
    meta: { version: app.isPackaged ? app.getVersion() : require('../../package.json').version, isPackaged: app.isPackaged, platform: process.platform, hotkeyActive: hotkey.ok, avatarModelUrl: localModelUrl() },
  };
}

/** Persist + push the new state to every window and the tray (coalesced per tick). */
function changed() {
  store.save();
  if (broadcastPending) return;
  broadcastPending = true;
  setImmediate(() => {
    broadcastPending = false;
    const state = publicState();
    for (const win of [overlay && overlay.win, settings && settings.win]) {
      if (!win || win.isDestroyed()) continue;
      const wc = win.webContents;
      if (wc.isDestroyed() || wc.isCrashed()) continue;
      try {
        wc.send('state:changed', state);
      } catch (err) {
        log.warn(`state push failed: ${err.message}`);
      }
    }
    if (tray) tray.refresh(state);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Run queue: one buddy visit on screen at a time

function enqueue(run) {
  run.id = crypto.randomUUID();
  if (run.preview) runs.queue = runs.queue.filter((q) => !q.preview); // only the newest draft matters
  const at = runs.queue.findIndex((q) => q.priority > run.priority);
  runs.queue.splice(at < 0 ? runs.queue.length : at, 0, run);
  processQueue();
}

const pendingRuns = () => (runs.visible ? [runs.visible, ...runs.queue] : runs.queue);
const hasRunFor = (id) => pendingRuns().some((r) => r.kind === 'reminder' && !r.preview && r.reminderId === id);

/** Queues a real (stat-counting) run. Manual = summon / tray / demo; otherwise fired by the scheduler. */
function enqueueReminder(id, { manual }) {
  if (hasRunFor(id) || !store.getReminder(id)) return false;
  if (manual) scheduler.begin(id, { manual: true });
  enqueue({ kind: 'reminder', reminderId: id, preview: false, priority: manual ? PRIORITY.user : PRIORITY.auto });
  return true;
}

function enqueueWelcome() {
  if (pendingRuns().some((r) => r.kind === 'welcome')) return;
  enqueue({ kind: 'welcome', preview: false, priority: PRIORITY.user });
}

function processQueue() {
  clearTimeout(runs.gapTimer);
  runs.gapTimer = null;
  if (runs.visible || !runs.queue.length || !overlay || !overlay.ready || quitting) return;
  const run = runs.queue[0];
  if (run.priority === PRIORITY.auto) {
    const wait = runs.lastEndedAt + TIMING.runGapMs - Date.now();
    if (wait > 0) {
      runs.gapTimer = setTimeout(processQueue, wait);
      return;
    }
  }
  runs.queue.shift();
  showRun(run);
}

function showRun(run) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const payload = buildPayload(run, area);
  if (!payload) {
    processQueue(); // its reminder was deleted while queued
    return;
  }
  const { win } = overlay;
  runs.visible = { ...run, displayId: display.id, responded: false, safety: null };
  win.setBounds(area);
  setClickThrough(true, true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive(); // never steal focus from what the user is doing
  win.setBounds(area); // re-apply: Windows may rescale a hidden window's bounds when it changes monitor DPI
  win.moveTop();
  win.webContents.send('overlay:run', payload);
  armSafety((payload.settings.autoDismissSec + 60) * 1000);
  startCapture();
  if (run.kind === 'welcome' && !store.data.runtime.onboarded) {
    store.data.runtime.onboarded = true;
    changed();
  }
  log.info(`run ${run.kind}${run.preview ? ' (preview)' : ''}: ${payload.reminder.title} on display ${display.id}`);
}

/** Force-hides the overlay if the renderer never reports back. */
function armSafety(ms) {
  const run = runs.visible;
  if (!run) return;
  clearTimeout(run.safety);
  run.safety = setTimeout(() => {
    if (runs.visible !== run) return;
    log.warn('overlay did not finish in time; hiding it');
    finishRun('stalled');
  }, ms);
}

function finishRun(reason) {
  const run = runs.visible;
  if (!run) return;
  runs.visible = null;
  clearTimeout(run.safety);
  stopCapture();
  if (!run.responded && run.kind === 'reminder' && !run.preview) {
    // Closed without an answer: a normal finish counts as dismissed, a lost run (crash/stall) is retried.
    scheduler.resolve(run.reminderId, reason === 'done' ? 'dismiss' : 'abort');
  }
  if (overlay && !overlay.win.isDestroyed()) {
    setClickThrough(true, true);
    overlay.win.hide();
  }
  runs.lastEndedAt = Date.now();
  processQueue();
}

function setClickThrough(on, force = false) {
  if (!overlay || overlay.win.isDestroyed()) return;
  if (!force && overlay.clickThrough === on) return;
  overlay.clickThrough = on;
  if (on) overlay.win.setIgnoreMouseEvents(true, { forward: true });
  else overlay.win.setIgnoreMouseEvents(false);
}

// ---------------------------------------------------------------------------------------------------------------
// Run payloads

function resolveAvatarId(id) {
  if (id === 'me3d' && !localModelUrl()) return 'nova';
  const s = store.data.settings;
  if (id !== 'custom' || s.customAvatar) return id;
  return s.avatarId !== 'custom' ? s.avatarId : D.DEFAULT_SETTINGS.avatarId;
}

function buildPayload(run, area) {
  const s = store.data.settings;
  const welcome = run.kind === 'welcome';
  const reminder = welcome ? welcomeReminder() : run.preview ? run.draft : store.getReminder(run.reminderId);
  if (!reminder) return null;
  const avatarId = resolveAvatarId(reminder.avatarId || s.avatarId);
  return {
    runId: run.id,
    kind: run.kind,
    preview: !!run.preview,
    reminder: clone(reminder),
    avatar: { id: avatarId, color: s.avatarColor, customUrl: avatarId === 'me3d' ? localModelUrl() : avatarId === 'custom' ? s.customAvatar.url : null },
    settings: {
      size: s.size,
      side: s.side,
      bubbleStyle: s.bubbleStyle,
      entrance: s.entrance,
      sound: s.sound,
      volume: s.volume,
      voice: s.voice,
      autoDismissSec: s.autoDismissSec,
    },
    vars: {
      name: s.userName || 'friend',
      snooze: reminder.snooze,
      count: welcome ? 0 : scheduler.countToday(reminder.id), // today's YES count before this run
      goal: reminder.goal || 0,
      title: reminder.title,
      laterStreak: welcome ? 0 : scheduler.streakFor(reminder.id),
    },
    display: { width: area.width, height: area.height },
  };
}

const formatClock = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

function describeEvery(minutes) {
  if (minutes === 1440) return 'day';
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`;
  return `${minutes} min`;
}

function describeTimes(times) {
  const list = times.map(formatClock);
  if (list.length === 1) return list[0];
  if (list.length <= 3) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more times`;
}

/** "to drink water" for verb-led titles, otherwise "about “Posture check”". */
function describeTask(title) {
  const [first, second = ''] = title.split(/\s+/);
  const verbLed =
    /^(drink|call|take|go|do|eat|read|move|stand|text|feed|practice|write|meditate|walk|stretch|breathe|check|look|clean|plan|journal|study|sleep|get|have|log|review|tidy|floss|brush|water)$/i.test(first) &&
    !/^(break|check|time|reminder|session)$/i.test(second);
  return verbLed ? `to ${title.charAt(0).toLowerCase()}${title.slice(1)}` : `about “${title}”`;
}

/** First-run introduction, built from the reminder the user will actually get. */
function welcomeReminder() {
  const first = store.data.reminders.find((r) => r.enabled) || store.data.reminders[0] || null;
  const base = first || D.makeReminder('water', 'welcome');
  let question = 'Tell me what to nudge you about and I’ll pop by.';
  if (first) {
    const { schedule } = first;
    const when = schedule.mode === 'times' ? `at ${describeTimes(schedule.times)}` : `every ${describeEvery(schedule.every)}`;
    const days = schedule.days.join(',');
    const on = days === '1,2,3,4,5' ? ' on weekdays' : days === '0,6' ? ' on weekends' : '';
    question = `I’ll remind you ${describeTask(first.title)} ${when}${on}.`;
  }
  return {
    ...clone(base),
    id: 'welcome',
    avatarId: null,
    greeting: 'Hi {name}! I’m {buddy} 👋',
    question,
    yesLabel: 'Sounds good',
    laterLabel: 'Customize',
    yesReply: `Let’s go! ${base.emoji}`,
    laterReply: 'Opening settings…',
    action: 'cheer',
    goal: 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Visual capture (--capture=<dir>): PNG frames of the overlay while a run is on screen

function startCapture() {
  if (!flags.capture || capture.timer) return;
  try {
    fs.mkdirSync(flags.capture, { recursive: true });
  } catch (err) {
    log.warn(`capture disabled: ${err.message}`);
    flags.capture = null;
    return;
  }
  capture.timer = setInterval(async () => {
    if (capture.busy || !runs.visible || !overlay || overlay.win.isDestroyed()) return;
    capture.busy = true;
    try {
      const image = await overlay.win.webContents.capturePage();
      const file = path.join(flags.capture, `frame-${String(++capture.frame).padStart(4, '0')}.png`);
      await fs.promises.writeFile(file, image.toPNG());
    } catch (err) {
      log.warn(`capture failed: ${err.message}`);
    } finally {
      capture.busy = false;
    }
  }, CAPTURE_EVERY_MS);
}

function stopCapture() {
  clearInterval(capture.timer);
  capture.timer = null;
}

// ---------------------------------------------------------------------------------------------------------------
// Overlay window

function createOverlay() {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    ...area,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    roundedCorners: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    title: 'Nudgi',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const o = { win, ready: false, clickThrough: null, unresponsiveTimer: null, loadAttempts: 0 };
  overlay = o;
  win.setAlwaysOnTop(true, 'screen-saver');
  setClickThrough(true, true);

  win.on('close', (e) => {
    if (!quitting) e.preventDefault();
  });
  win.on('closed', () => {
    if (overlay === o) overlay = null;
  });
  win.on('session-end', () => store.flush());

  const wc = win.webContents;
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) o.ready = false;
  });
  wc.on('render-process-gone', (_e, details) => {
    if (quitting) return;
    log.warn(`overlay renderer gone (${details.reason}); recreating`);
    recoverOverlay(o);
  });
  wc.on('unresponsive', () => {
    clearTimeout(o.unresponsiveTimer);
    o.unresponsiveTimer = setTimeout(() => {
      log.warn('overlay unresponsive; recreating');
      recoverOverlay(o);
    }, 8000);
  });
  wc.on('responsive', () => clearTimeout(o.unresponsiveTimer));
  if (!app.isPackaged && process.env.NUDGE_DEVTOOLS === 'overlay') wc.openDevTools({ mode: 'detach', activate: false });

  loadOverlay(o);
}

function loadOverlay(o) {
  if (overlay !== o || o.win.isDestroyed()) return;
  const retry = (why) => {
    const delay = Math.min(60000, 5000 * 2 ** o.loadAttempts++);
    log.warn(`overlay page unavailable (${why}); retrying in ${delay / 1000}s`);
    setTimeout(() => loadOverlay(o), delay);
  };
  if (!fs.existsSync(PAGES.overlay)) {
    retry('file not found');
    return;
  }
  o.win.loadFile(PAGES.overlay).catch((err) => {
    if (overlay === o && !o.ready) retry(err.message);
  });
}

/** Renderer crashed or hung: drop the visible run (retried later), destroy and rebuild the window. */
function recoverOverlay(o) {
  if (overlay !== o) return;
  clearTimeout(o.unresponsiveTimer);
  o.ready = false;
  finishRun('crash');
  overlay = null;
  setImmediate(() => {
    if (!o.win.isDestroyed()) o.win.destroy();
  });
  const now = Date.now();
  overlayCrashes = overlayCrashes.filter((t) => now - t < 60000).concat(now);
  const delay = overlayCrashes.length > 3 ? 30000 : 1000; // crash loop → back off
  setTimeout(() => {
    if (!quitting && !overlay) createOverlay();
  }, delay);
}

function refitOverlay() {
  const run = runs.visible;
  if (!run || !overlay || overlay.win.isDestroyed()) return;
  const display = screen.getAllDisplays().find((d) => d.id === run.displayId) || screen.getPrimaryDisplay();
  run.displayId = display.id;
  overlay.win.setBounds(display.workArea);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings window

const themeColors = () => (nativeTheme.shouldUseDarkColors ? THEMES.dark : THEMES.light);

function openSettings() {
  if (settings && !settings.win.isDestroyed()) {
    const { win } = settings;
    if (win.isMinimized()) win.restore();
    if (settings.ready) {
      win.show();
      win.focus();
    }
    return;
  }
  if (!fs.existsSync(PAGES.settings)) {
    log.warn('settings page not found');
    return;
  }
  const theme = themeColors();
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'Nudgi',
    icon: APP_ICON,
    backgroundColor: theme.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.background, symbolColor: theme.symbols, height: 44 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const s = { win, ready: false };
  settings = s;
  const reveal = () => {
    if (s.ready || win.isDestroyed()) return;
    s.ready = true;
    win.show();
    win.focus();
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 4000); // never leave the user waiting on a page that failed to paint
  win.on('closed', () => {
    if (settings === s) settings = null;
  });
  win.on('session-end', () => store.flush());

  const wc = win.webContents;
  let crashes = [];
  wc.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60000).concat(now);
    if (crashes.length > 3) {
      log.error('settings keeps crashing; closing it');
      setImmediate(() => !win.isDestroyed() && win.destroy());
      return;
    }
    log.warn(`settings renderer gone (${details.reason}); reloading`);
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (input.control && key === 'w') {
      event.preventDefault();
      win.close();
    } else if (!app.isPackaged && (input.key === 'F12' || (input.control && input.shift && key === 'i'))) {
      event.preventDefault();
      wc.toggleDevTools();
    } else if (!app.isPackaged && input.control && key === 'r') {
      event.preventDefault();
      wc.reload();
    }
  });
  win.loadFile(PAGES.settings).catch((err) => log.error(`settings failed to load: ${err.message}`));
}

function applyTheme() {
  if (!settings || settings.win.isDestroyed()) return;
  const theme = themeColors();
  settings.win.setTitleBarOverlay({ color: theme.background, symbolColor: theme.symbols, height: 44 });
  settings.win.setBackgroundColor(theme.background);
}

// ---------------------------------------------------------------------------------------------------------------
// Actions shared by IPC, tray, hotkey and CLI

function summon() {
  if (runs.visible && !runs.visible.preview) return; // the buddy is already here
  if (runs.queue.some((r) => !r.preview)) return;
  const r = scheduler.soonest();
  if (r) enqueueReminder(r.id, { manual: true });
  else openSettings(); // nothing to show yet → help the user add a reminder
}

function showReminder(id) {
  const r = store.getReminder(id);
  if (r && r.enabled) enqueueReminder(id, { manual: true });
}

function demo() {
  const r = store.data.reminders.find((x) => x.enabled) || store.data.reminders[0];
  if (r) enqueueReminder(r.id, { manual: true });
  else log.warn('--demo: there are no reminders to show');
}

function pauseFor(minutes) {
  scheduler.setPause(minutes === null ? startOfTomorrow(Date.now()) : Date.now() + minutes * 60000);
}

function quit() {
  quitting = true;
  app.quit();
}

function handleLaunchFlags(f, fromSecondInstance) {
  if (f.demo) setTimeout(demo, fromSecondInstance ? 300 : 2500);
  if (f.welcome && fromSecondInstance) enqueueWelcome();
  if (f.summon) setTimeout(summon, fromSecondInstance ? 0 : 1500);
  const acted = f.demo || f.welcome || f.summon;
  if (f.settings || (!f.background && !acted)) openSettings();
}

// ---------------------------------------------------------------------------------------------------------------
// System integration

function registerHotkey() {
  const accel = store.data.settings.hotkey;
  if (hotkey.ok && hotkey.accel === accel) return;
  if (hotkey.ok) globalShortcut.unregister(hotkey.accel);
  hotkey.accel = accel;
  hotkey.ok = false;
  if (!accel) return;
  try {
    hotkey.ok = globalShortcut.register(accel, summon);
  } catch (err) {
    log.warn(`hotkey "${accel}" rejected: ${err.message}`);
  }
  if (!hotkey.ok) log.warn(`hotkey "${accel}" is unavailable (another app may own it)`);
}

const launcherPath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

function applyLoginItem() {
  if (!app.isPackaged || userDataOverride) return; // isolated verification must not alter the user's startup entry
  try {
    app.setLoginItemSettings({ openAtLogin: store.data.settings.launchAtLogin, path: launcherPath(), args: ['--background'] });
  } catch (err) {
    log.warn(`login item: ${err.message}`);
  }
}

function setJumpList() {
  if (!app.isPackaged || userDataOverride || process.platform !== 'win32') return;
  const exe = launcherPath();
  app.setUserTasks([
    { program: exe, arguments: '--summon', iconPath: exe, iconIndex: 0, title: 'Summon buddy', description: 'Bring your buddy on screen now' },
    { program: exe, arguments: '--settings', iconPath: exe, iconIndex: 0, title: 'Open settings', description: 'Edit reminders and your buddy' },
  ]);
}

function schedulerEnv() {
  let idleSec = 0;
  let locked = false;
  try {
    idleSec = powerMonitor.getSystemIdleTime();
    locked = powerMonitor.getSystemIdleState(TIMING.idleBlockSec) === 'locked';
  } catch {
    /* treat as active */
  }
  return { idleSec, locked, busy: !!runs.visible || runs.queue.length > 0, lastRunEndedAt: runs.lastEndedAt };
}

function watchSystem() {
  const reevaluate = () => setTimeout(() => scheduler.tick(), 1500);
  powerMonitor.on('resume', reevaluate);
  powerMonitor.on('unlock-screen', reevaluate);
  screen.on('display-removed', refitOverlay);
  screen.on('display-metrics-changed', refitOverlay);
  nativeTheme.on('updated', applyTheme);
}

/** No new windows, no navigation, no webviews, no permissions — for every webContents. */
function harden() {
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // NUDGE_DEBUG=1 → forward renderer console warnings/errors to stdout for troubleshooting.
    if (process.env.NUDGE_DEBUG) wc.on('console-message', (e) => { if (e.level !== 'info' && e.level !== 'debug') console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`); });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

// ---------------------------------------------------------------------------------------------------------------
// Custom avatar images

function localModelUrl() {
  const file = path.join(app.getPath('userData'), 'avatars', 'avatar.glb');
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${pathToFileURL(file).href}?v=${stat.mtimeMs}` : null;
  } catch { return null; }
}

async function pickAvatarModel() {
  const result = await dialog.showOpenDialog(settings.win, {
    title: 'Import your Avaturn avatar', properties: ['openFile'],
    filters: [{ name: '3D avatar (GLB)', extensions: ['glb'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const src = result.filePaths[0];
  if (path.extname(src).toLowerCase() !== '.glb' || fs.statSync(src).size > 25 * 1024 * 1024) throw new Error('Choose a GLB model under 25 MB.');
  const bytes = await fs.promises.readFile(src);
  validateModel(bytes);
  await fs.promises.mkdir(store.avatarsDir, { recursive: true });
  const dest = path.join(store.avatarsDir, 'avatar.glb');
  if (fs.existsSync(dest)) await fs.promises.copyFile(dest, `${dest}.previous`);
  const pending = `${dest}.pending`;
  await fs.promises.writeFile(pending, bytes);
  await fs.promises.rename(pending, dest);
  store.updateSettings({ avatarId: 'me3d' });
  changed();
  return publicState();
}

async function looksLikeImage(file, ext) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    switch (ext) {
      case 'png':
        return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      case 'jpg':
      case 'jpeg':
        return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      case 'gif':
        return /^GIF8[79]a/.test(head.toString('latin1', 0, 6));
      case 'webp':
        return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
      case 'svg':
        return /<svg[\s>]/i.test(head.toString('utf8'));
      default:
        return false;
    }
  } finally {
    await fh.close();
  }
}

/** Deletes a previously copied avatar — only ever inside userData/avatars. */
function removeAvatarFile(customAvatar) {
  if (!customAvatar || typeof customAvatar.url !== 'string') return;
  try {
    const file = fileURLToPath(customAvatar.url);
    if (isInside(store.avatarsDir, file)) fs.rmSync(file, { force: true });
  } catch (err) {
    log.warn(`could not remove old avatar: ${err.message}`);
  }
}

async function pickAvatarImage() {
  const parent = settings && !settings.win.isDestroyed() ? settings.win : null;
  const options = {
    title: 'Choose an image for your buddy',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return null;

  const src = result.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  const reject = async (message) => {
    const box = { type: 'warning', title: 'Nudgi', message, buttons: ['OK'] };
    await (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box));
    return null;
  };
  if (!IMAGE_EXTS.includes(ext)) return reject('Please choose a PNG, JPG, GIF, WebP or SVG image.');
  const stat = await fs.promises.stat(src);
  if (!stat.isFile() || stat.size === 0) return reject('That file looks empty.');
  if (stat.size > MAX_AVATAR_BYTES) return reject('That image is larger than 8 MB — please pick a smaller one.');
  if (!(await looksLikeImage(src, ext))) return reject('That file doesn’t look like a valid image.');

  await fs.promises.mkdir(store.avatarsDir, { recursive: true });
  const dest = path.join(store.avatarsDir, `custom-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`);
  await fs.promises.copyFile(src, dest);
  removeAvatarFile(store.data.settings.customAvatar);
  store.setCustomAvatar({ url: pathToFileURL(dest).href, name: cleanText(path.basename(src), 80) || 'image' });
  changed();
  return publicState();
}

// ---------------------------------------------------------------------------------------------------------------
// IPC (every payload is untrusted; every sender is checked)

/** Is `url` one of our bundled renderer pages? Compares decoded paths, so URL-encoding quirks can't matter. */
function isOwnPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && isInside(RENDERER_DIR, fileURLToPath(u));
  } catch {
    return false;
  }
}

/** Main frame of one of our own pages. */
function trusted(e) {
  const frame = e.senderFrame;
  return !!frame && !frame.parent && isOwnPage(frame.url);
}
const fromOverlay = (e) => !!overlay && !overlay.win.isDestroyed() && e.sender === overlay.win.webContents && trusted(e);
const fromSettings = (e) => !!settings && !settings.win.isDestroyed() && e.sender === settings.win.webContents && trusted(e);
const fromApp = (e) => fromOverlay(e) || fromSettings(e);

function handle(channel, guard, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!guard(e)) throw new Error('Not allowed');
    return fn(...args);
  });
}

function registerIpc() {
  handle('state:get', fromApp, () => publicState());

  handle('settings:update', fromSettings, (patch) => {
    const keys = store.updateSettings(patch);
    if (keys.includes('hotkey')) registerHotkey();
    if (keys.includes('launchAtLogin')) applyLoginItem();
    if (keys.length) changed();
    return publicState();
  });

  handle('reminder:save', fromSettings, (raw) => {
    const { prev, reminder } = store.saveReminder(raw);
    scheduler.reminderSaved(prev, reminder);
    changed();
    return publicState();
  });

  handle('reminder:delete', fromSettings, (id) => {
    const removed = store.deleteReminder(id);
    if (removed) {
      scheduler.reminderRemoved(removed.id);
      runs.queue = runs.queue.filter((q) => q.preview || q.reminderId !== removed.id);
      changed();
    }
    return publicState();
  });

  handle('reminder:test', fromSettings, (raw) => {
    if (!isObj(raw)) return false;
    const source = isId(raw.id) ? raw : { ...raw, id: 'preview' };
    const draft = sanitizeReminder(source, store.getReminder(source.id) || undefined);
    if (!draft) return false;
    enqueue({ kind: 'reminder', preview: true, draft, priority: PRIORITY.preview });
    return true;
  });

  handle('avatar:pick', fromSettings, () => pickAvatarImage());
  handle('avatar:model', fromSettings, () => pickAvatarModel());
  handle('avatar:guide', fromSettings, async () => { await shell.openExternal('https://avaturn.me/'); return true; });

  handle('avatar:clear', fromSettings, () => {
    removeAvatarFile(store.data.settings.customAvatar);
    store.setCustomAvatar(null);
    changed();
    return publicState();
  });

  handle('pause:set', fromSettings, (until) => {
    scheduler.setPause(until);
    return publicState();
  });

  handle('stats:reset', fromSettings, () => {
    store.resetStats();
    changed();
    return publicState();
  });

  ipcMain.on('window:openSettings', (e) => {
    if (fromApp(e)) openSettings();
  });

  ipcMain.on('overlay:ready', (e) => {
    if (!fromOverlay(e)) return;
    if (runs.visible) finishRun('reloaded'); // the page restarted mid-run
    overlay.ready = true;
    overlay.loadAttempts = 0;
    processQueue();
  });

  ipcMain.on('overlay:respond', (e, msg) => {
    if (!fromOverlay(e) || !isObj(msg)) return;
    const run = runs.visible;
    if (!run || run.id !== msg.runId || run.responded || !RESPONSES.includes(msg.outcome)) return;
    run.responded = true;
    if (run.kind === 'reminder' && !run.preview) scheduler.resolve(run.reminderId, msg.outcome);
    // Welcome "Customize": the overlay opens settings itself; this guarantees it (openSettings is idempotent).
    if (run.kind === 'welcome' && msg.outcome === 'later') setTimeout(openSettings, 1200);
    armSafety(EXIT_GRACE_MS);
  });

  ipcMain.on('overlay:done', (e, msg) => {
    if (fromOverlay(e) && isObj(msg) && runs.visible && runs.visible.id === msg.runId) finishRun('done');
  });

  ipcMain.on('overlay:interactive', (e, value) => {
    if (!fromOverlay(e) || typeof value !== 'boolean') return;
    setClickThrough(!(value && runs.visible));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle

function boot() {
  Menu.setApplicationMenu(null); // no hidden accelerators (reload, devtools) in production windows
  harden();

  store = new Store({ dir: app.getPath('userData'), log });
  store.load();
  scheduler = new Scheduler({
    getData: () => store.data,
    env: schedulerEnv,
    onFire: (r) => enqueueReminder(r.id, { manual: false }),
    onChange: () => changed(),
  });

  registerIpc();
  createOverlay();
  tray = createTray({
    assetsDir: ASSETS,
    getState: publicState,
    actions: { summon, show: showReminder, pause: pauseFor, resume: () => scheduler.setPause(null), openSettings, quit },
  });
  registerHotkey();
  applyLoginItem();
  setJumpList();
  watchSystem();
  scheduler.start();

  // First launch: the buddy introduces itself (--demo skips it so captures show the reminder itself).
  if (flags.welcome || (!store.data.runtime.onboarded && !flags.demo)) setTimeout(enqueueWelcome, 1500);
  handleLaunchFlags(flags, false);
  log.info(`ready (userData: ${app.getPath('userData')})`);
}

process.on('uncaughtException', (err) => log.error('uncaught exception:', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.vrajpatel.nudgebuddy');
  app.enableSandbox();
  app.on('second-instance', (_e, argv) => {
    if (app.isReady() && store) handleLaunchFlags(parseFlags(argv), true);
  });
  app.on('window-all-closed', () => {
    /* lives in the tray */
  });
  app.on('before-quit', () => {
    quitting = true;
    if (scheduler) scheduler.stop();
    stopCapture();
    if (store) store.flush();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tray) tray.destroy();
  });
  app
    .whenReady()
    .then(boot)
    .catch((err) => {
      log.error('startup failed:', err);
      app.exit(1);
    });
}
