// Settings window entry: shared state store, navigation, title-bar status and the 1 s ticker.
import '../shared/mock-api.js';
import { sfx } from '../shared/sound.js';
import { $, $$, h, debounce, radioGroup, setSeg, toast, untilText, pausedText, dayKey } from './ui.js';
import { mountReminders } from './reminders.js';
import { mountBuddy } from './buddy.js';
import { mountGeneral } from './general.js';
import { mountToday } from './today.js';

const nudge = window.nudge;
const listeners = new Set();

const cleanError = (err) =>
  String((err && err.message) || err || 'Something went wrong')
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');

const app = {
  state: await nudge.getState(),
  nudge,
  onState(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Calls a bridge method; applies a returned state; toasts and resolves undefined on failure. */
  async call(method, ...args) {
    try {
      const res = await nudge[method](...args);
      if (res && typeof res === 'object' && res.settings) apply(res);
      return res;
    } catch (err) {
      toast(cleanError(err), 'error');
      return undefined;
    }
  },
  update: (patch) => app.call('updateSettings', patch),
  /** Wires [data-setting] switches, ranges and segmented groups inside root to settings. */
  bind(root) {
    const els = $$('[data-setting]', root);
    for (const el of els) {
      const key = el.dataset.setting;
      if (el.classList.contains('seg')) {
        radioGroup(el, (value) => {
          setSeg(el, value);
          app.update({ [key]: value });
        });
      } else if (el.type === 'checkbox') {
        el.addEventListener('change', () => app.update({ [key]: el.checked }));
      } else if (el.type === 'range') {
        const send = debounce(() => app.update({ [key]: Number(el.value) }), 150);
        el.addEventListener('input', send);
        el.addEventListener('change', () => send.flush());
      }
    }
    const sync = ({ settings }) => {
      for (const el of els) {
        const v = settings[el.dataset.setting];
        if (el.classList.contains('seg')) setSeg(el, v);
        else if (el.type === 'checkbox') el.checked = !!v;
        else if (el !== document.activeElement) el.value = v;
      }
    };
    app.onState(sync);
    sync(app.state);
  },
};

function apply(next) {
  app.state = next;
  sfx.enabled = !!next.settings.sound;
  sfx.volume = next.settings.volume;
  for (const fn of listeners) fn(next);
  renderStatus();
}
nudge.onState((next) => apply(next));

// ---- navigation ----
const sections = {
  reminders: mountReminders($('#sec-reminders'), app),
  buddy: mountBuddy($('#sec-buddy'), app),
  general: mountGeneral($('#sec-general'), app),
  today: mountToday($('#sec-today'), app),
};
const navItems = $$('.nav-item');
let current = null;

function go(id, { focus = false } = {}) {
  if (!sections[id]) id = 'reminders';
  if (id === current) return sections[id].home?.();
  if (current) {
    sections[current].deactivate?.();
    $(`#sec-${current}`).hidden = true;
  }
  current = id;
  $(`#sec-${id}`).hidden = false;
  for (const b of navItems) {
    if (b.dataset.section === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('#main').scrollTop = 0;
  sections[id].activate?.();
  if (focus) $('#main').focus({ preventScroll: true });
  history.replaceState(null, '', `#${id}`);
}

for (const b of navItems) {
  b.addEventListener('click', () => go(b.dataset.section, { focus: true }));
  b.addEventListener('keydown', (e) => {
    const dir = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = navItems.indexOf(b);
    navItems[(i + dir + navItems.length) % navItems.length].focus();
  });
}

// ---- title-bar status ----
const statusEl = $('#status');
const statusText = $('#status-text');
const resumeBtn = $('#status-resume');
resumeBtn.addEventListener('click', () => app.call('setPause', null));

function renderStatus() {
  const { runtime, reminders } = app.state;
  const now = Date.now();
  let kind = 'idle';
  let text = 'No reminders on';
  if (runtime.pausedUntil && runtime.pausedUntil > now) {
    kind = 'paused';
    text = `Paused until ${pausedText(runtime.pausedUntil)}`;
  } else {
    const upcoming = reminders
      .filter((r) => r.enabled && runtime.next[r.id])
      .sort((a, b) => runtime.next[a.id] - runtime.next[b.id])[0];
    if (upcoming) {
      kind = 'next';
      text = `Next: ${upcoming.title} · ${untilText(runtime.next[upcoming.id], now)}`;
    } else if (reminders.some((r) => r.enabled)) {
      text = 'All done for today';
    }
  }
  if (statusText.textContent !== text) statusText.textContent = text;
  statusEl.dataset.kind = kind;
  resumeBtn.hidden = kind !== 'paused';
}

// ---- 1 s ticker: countdowns only (never touches inputs) ----
let today = dayKey();
setInterval(() => {
  renderStatus();
  if (dayKey() !== today) {
    today = dayKey();
    apply(app.state);
  }
  sections[current]?.tick?.();
}, 1000);

$('#version').append(h('span', { class: 'nav-label', text: 'Nudgi ' }), `v${app.state.meta?.version || ''}`);
apply(app.state);
go(location.hash.slice(1));
addEventListener('hashchange', () => go(location.hash.slice(1)));
