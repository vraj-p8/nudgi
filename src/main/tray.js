'use strict';

// Notification-area icon: live tooltip + context menu. The menu is rebuilt on every state change and every 30 s
// (so "in N min" stays honest), but only swapped when its content actually changed.

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

const REFRESH_MS = 30 * 1000;
const PAUSES = [
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: 'Until tomorrow', minutes: null },
];

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "in 23 min" · "in 1 h 5 min" · "at 6:30 PM" · "tomorrow 9:00 AM" · "Fri 9:00 AM". */
function relative(ms, now) {
  const diff = ms - now;
  if (diff <= 0) return 'due now';
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 6 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `in ${h} h ${m} min` : `in ${h} h`;
  }
  const day = new Date(ms);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day.toDateString() === today.toDateString()) return `at ${clock(ms)}`;
  if (day.toDateString() === tomorrow.toDateString()) return `tomorrow ${clock(ms)}`;
  return `${day.toLocaleDateString([], { weekday: 'short' })} ${clock(ms)}`;
}

function pausedLabel(until, now) {
  const end = new Date(until);
  const sameDay = end.toDateString() === new Date(now).toDateString();
  if (sameDay) return `Paused until ${clock(until)}`;
  if (end.getHours() === 0 && end.getMinutes() === 0 && until - now <= 24 * 3600e3) return 'Paused until tomorrow';
  return `Paused until ${end.toLocaleDateString([], { weekday: 'short' })} ${clock(until)}`;
}

/** The status line shared by the tooltip and the menu. */
function status(state, now = Date.now()) {
  const { reminders, runtime } = state;
  if (runtime.pausedUntil && runtime.pausedUntil > now) return { paused: true, text: pausedLabel(runtime.pausedUntil, now) };
  let best = null;
  for (const r of reminders) {
    const next = runtime.next[r.id];
    if (r.enabled && Number.isFinite(next) && (!best || next < best.next)) best = { r, next };
  }
  if (!best) {
    const anyOn = reminders.some((r) => r.enabled);
    return { paused: false, text: anyOn ? 'Nothing scheduled' : 'No reminders on' };
  }
  return { paused: false, text: `Next: ${best.r.title} ${relative(best.next, now)}` };
}

/**
 * @param {object} o
 * @param {string} o.assetsDir
 * @param {() => object} o.getState  public app state (settings, reminders, runtime)
 * @param {{summon, show, pause, resume, openSettings, quit}} o.actions
 */
function createTray({ assetsDir, getState, actions }) {
  const icon = (name) => {
    const img = nativeImage.createFromPath(path.join(assetsDir, name)); // picks up name@2x.png automatically
    return img.isEmpty() ? null : img;
  };
  const images = { normal: icon('tray.png') || nativeImage.createEmpty() };
  images.paused = icon('tray-paused.png') || images.normal;

  const tray = new Tray(images.normal);
  let signature = '';
  let pausedIcon = false;

  tray.on('click', () => actions.openSettings());
  tray.on('double-click', () => actions.openSettings());

  function buildTemplate(state, st) {
    const enabled = state.reminders.filter((r) => r.enabled);
    // Show the shortcut only when it is really registered.
    const hotkey = state.meta && state.meta.hotkeyActive ? state.settings.hotkey : undefined;
    return [
      { label: 'Nudgi', enabled: false },
      { label: st.text, enabled: false },
      { label: 'Summon buddy now', accelerator: hotkey, registerAccelerator: false, click: () => actions.summon() },
      {
        label: 'Show reminder',
        submenu: enabled.length
          ? enabled.map((r) => ({ label: r.title.replace(/&/g, '&&'), click: () => actions.show(r.id) }))
          : [{ label: 'No reminders enabled', enabled: false }],
      },
      {
        label: 'Pause',
        submenu: [
          ...PAUSES.map((p) => ({ label: p.label, click: () => actions.pause(p.minutes) })),
          { type: 'separator' },
          { label: 'Resume', enabled: st.paused, click: () => actions.resume() },
        ],
      },
      { label: 'Open settings…', click: () => actions.openSettings() },
      { type: 'separator' },
      { label: 'Quit Nudgi', click: () => actions.quit() },
    ];
  }

  function refresh(state = getState()) {
    if (tray.isDestroyed()) return;
    const st = status(state);
    tray.setToolTip(`Nudgi - ${st.text.charAt(0).toLowerCase()}${st.text.slice(1)}`.slice(0, 127));
    if (st.paused !== pausedIcon) {
      pausedIcon = st.paused;
      tray.setImage(st.paused ? images.paused : images.normal);
    }
    const template = buildTemplate(state, st);
    const sig = JSON.stringify(template, (k, v) => (typeof v === 'function' ? undefined : v));
    if (sig === signature) return;
    signature = sig;
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  const timer = setInterval(() => refresh(), REFRESH_MS);
  refresh();

  return {
    refresh,
    destroy() {
      clearInterval(timer);
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}

module.exports = { createTray, status, relative };
