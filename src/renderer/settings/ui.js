// Small DOM + formatting helpers shared by the settings sections.
// User-authored text is only ever assigned through `text` (textContent); `html` is reserved for static icons.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PROPS_AS_FIELDS = new Set(['value', 'checked', 'disabled', 'hidden', 'type']);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (PROPS_AS_FIELDS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((c) => c != null && c !== false));
  return el;
}

export function debounce(fn, ms) {
  let t = 0;
  let args = null;
  const run = (...a) => {
    args = a;
    clearTimeout(t);
    t = setTimeout(() => ((t = 0), fn(...args)), ms);
  };
  run.flush = () => t && (clearTimeout(t), (t = 0), fn(...args));
  run.cancel = () => (clearTimeout(t), (t = 0));
  run.pending = () => !!t;
  return run;
}

const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** Length in user-perceived characters (an emoji counts once), whitespace-collapsed like the main process. */
export const glen = (s) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return SEG ? [...SEG.segment(flat)].length : [...flat].length;
};

// ---- names shown in the UI ----
export const BUDDY_NAMES = { me3d: 'My 3D avatar', nova: 'Kai', custom: 'Your image' };
export const buddyName = (id) => BUDDY_NAMES[id] || BUDDY_NAMES.nova;
/** Name used inside spoken text ({buddy}); matches the overlay. */
export const spokenBuddyName = (id) => (id === 'me3d' ? 'your 3D twin' : buddyName(id));

// ---- dates & times ----
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const shortHM = (hm) => String(hm || '').replace(/^0(\d)/, '$1');
export const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function untilText(ms, now = Date.now()) {
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return m % 60 ? `${hrs} h ${m % 60} min` : `${hrs} h`;
}

export function pausedText(until) {
  const d = new Date(until);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return clock(until);
  if (d.getTime() === tomorrow.getTime()) return 'tomorrow';
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(until)}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function daysText(days = []) {
  const set = [...new Set(days)].sort();
  const key = set.join('');
  if (key === '0123456') return 'Every day';
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  return set.map((d) => DAY_NAMES[d]).join(', ') || 'No days';
}

export function scheduleText(r) {
  const s = r.schedule;
  const when = s.mode === 'times'
    ? `At ${[...s.times].sort().map(shortHM).join(', ')}`
    : `Every ${s.every} min · ${shortHM(s.from)}-${shortHM(s.to)}`;
  return `${when} · ${daysText(s.days)}`;
}

// ---- toasts ----
export function toast(message, kind = 'info') {
  const host = $('#toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message });
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, kind === 'error' ? 5000 : 2600);
}

// ---- segmented radio groups: <div class="seg" role="radiogroup"><button role="radio" data-value> ----
export function setSeg(group, value) {
  for (const b of group.querySelectorAll('[role="radio"]')) {
    const on = b.dataset.value === String(value);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/** Click + arrow-key handling for a radiogroup; calls onPick(value). */
export function radioGroup(group, onPick) {
  const items = () => [...group.querySelectorAll('[role="radio"]:not([disabled])')];
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (b && group.contains(b) && !b.disabled) onPick(b.dataset.value, b);
  });
  group.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = list[(i + dir + list.length) % list.length];
    next.focus();
    onPick(next.dataset.value, next);
  });
}

/** Two-step destructive button: first click arms it (label swaps), second click within 3.5 s confirms. */
export function confirmButton(btn, armedLabel, onConfirm) {
  const label = btn.textContent;
  let timer = 0;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove('armed');
    btn.textContent = label;
  };
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = armedLabel;
      timer = setTimeout(disarm, 3500);
      return;
    }
    disarm();
    onConfirm();
  });
  btn.addEventListener('blur', disarm);
}

// ---- static icons (24px, stroke = currentColor) ----
const svg = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const ICON = {
  play: svg('<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>'),
  more: svg('<circle cx="12" cy="5.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  trash: svg('<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>'),
  x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  flame: svg('<path d="M12 21c3.6 0 6-2.5 6-5.8 0-3.6-2.6-5.7-3.6-9.2-2.4 1.6-3.6 3.7-3.4 6.2-1.3-.6-2-1.9-2.1-3.5C7.2 10.4 6 12.6 6 15.2 6 18.5 8.4 21 12 21z"/>'),
  upload: svg('<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 15v2.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V15"/>'),
};
