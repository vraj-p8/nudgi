// Reminders section: reminder cards, the template gallery and the autosaving editor.
import { ACTIONS } from '../shared/avatar-engine.js';
import { PROPS, createPropIcon } from '../shared/props.js';
import { fill } from '../shared/text.js';
import { createPreview } from './preview.js';
import {
  $, $$, h, clone, debounce, glen, toast, setSeg, radioGroup, confirmButton, ICON,
  scheduleText, untilText, dayKey, buddyName,
} from './ui.js';

// Mirrors LIMITS in src/main/defaults.js (the main process re-validates everything).
const L = { title: 40, emoji: 8, greeting: 60, question: 90, label: 24, reply: 80, every: [1, 1440], snooze: [1, 240], goal: [0, 30], maxTimes: 12, maxReminders: 30 };
const TEXT = {
  title: { label: 'Title', max: L.title },
  emoji: { max: L.emoji },
  greeting: { label: 'Greeting', max: L.greeting, optional: true },
  question: { label: 'Question', max: L.question },
  yesLabel: { label: 'YES button', max: L.label },
  laterLabel: { label: 'Later button', max: L.label },
  yesReply: { label: 'Reply after YES', max: L.reply },
  laterReply: { label: 'Reply after Later', max: L.reply },
};
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const QUICK_EMOJI = ['💧', '📞', '🙆', '👀', '🧍', '🚶', '💊', '🫁', '☕', '📖', '🧘', '🍎', '🌿', '⭐'];
const PROP_LABELS = { bottle: 'Bottle', glass: 'Glass', phone: 'Phone', mug: 'Mug', pill: 'Vitamin', dumbbell: 'Weight', glasses: 'Glasses', book: 'Book', emoji: 'Emoji', none: 'Nothing' };
const ACTION_ICONS = { drink: '🥤', call: '📞', stretch: '🙆', breathe: '🌬️', cheer: '🎉', nod: '👍' };
const NONE_SVG = '<circle cx="0" cy="-15" r="15" fill="none" stroke="currentColor" stroke-width="3" opacity=".45"/><path d="M-10.5 -4.5l21 -21" stroke="currentColor" stroke-width="3" opacity=".45"/>';

const num = (v) => (String(v).trim() === '' ? NaN : Number(v));
const isInt = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

export function validate(d) {
  const e = {};
  for (const [k, { max, optional }] of Object.entries(TEXT)) {
    const n = glen(d[k]);
    if (!n && !optional) e[k] = k === 'emoji' ? 'Pick an emoji' : 'This can’t be empty';
    else if (n > max) e[k] = `Keep it to ${max} characters (now ${n})`;
  }
  const s = d.schedule;
  if (s.mode === 'interval') {
    if (!isInt(s.every, L.every)) e.every = 'Choose between 1 and 1440 minutes';
    if (!HM.test(s.from) || !HM.test(s.to)) e.hours = 'Set both a start and an end time';
  } else if (!s.times.length) e.times = 'Add at least one time';
  else if (s.times.some((t) => !HM.test(t))) e.times = 'Fill in every time';
  if (!s.days.length) e.days = 'Pick at least one day';
  if (!isInt(d.snooze, L.snooze)) e.snooze = 'Choose between 1 and 240 minutes';
  if (!isInt(d.goal, L.goal)) e.goal = 'Choose 0–30 (0 turns it off)';
  return e;
}

const cleanDraft = (d) => {
  const times = [...new Set(d.schedule.times.filter((t) => HM.test(t)))].sort();
  return { ...clone(d), schedule: { ...clone(d.schedule), times: times.length ? times : ['10:00'] } };
};

export function mountReminders(root, app) {
  const listView = $('#rem-list-view', root);
  const cardsEl = $('#rem-cards', root);
  const editorEl = $('#rem-editor', root);
  const form = $('#ed-form', root);
  const gallery = $('#gallery');
  const cards = new Map();
  const ed = { id: null, draft: null, rev: 0, preview: null, lastText: null };

  const find = (id) => app.state.reminders.find((r) => r.id === id);
  const todayYes = (id) => app.state.stats[id]?.[dayKey()]?.yes || 0;
  const atLimit = () => app.state.reminders.length >= L.maxReminders;

  // ================= cards =================
  function nextText(r) {
    if (!r.enabled) return 'Off';
    const { pausedUntil, next } = app.state.runtime;
    if (pausedUntil && pausedUntil > Date.now()) return 'Paused';
    return next[r.id] ? `Next in ${untilText(next[r.id])}` : 'Nothing more today';
  }

  function closeMenus(except) {
    for (const c of cards.values()) {
      if (c === except || c.menu.hidden) continue;
      c.menu.hidden = true;
      c.kebab.setAttribute('aria-expanded', 'false');
    }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });

  function createCard(id) {
    const c = { id };
    c.emoji = h('span', { class: 'card-emoji', 'aria-hidden': 'true' });
    c.title = h('span', { class: 'card-title' });
    c.sub = h('span', { class: 'card-sub' });
    c.open = h('button', { type: 'button', class: 'card-open', onclick: () => openEditor(id) }, c.emoji, h('span', { class: 'card-text' }, c.title, c.sub));
    c.toggle = h('input', {
      type: 'checkbox', class: 'switch',
      onchange: async () => {
        const r = find(id);
        if (r && !(await app.call('saveReminder', { ...r, enabled: c.toggle.checked }))) c.toggle.checked = r.enabled;
      },
    });
    c.next = h('span', { class: 'pill-text' });
    c.count = h('span', { class: 'pill-text' });
    c.bar = h('span', { class: 'mini-bar' }, h('i'));
    c.test = h('button', {
      type: 'button', class: 'icon-btn test', html: ICON.play,
      onclick: async () => {
        const r = find(id);
        if (r && (await app.call('testReminder', r))) {
          c.test.classList.add('sent');
          setTimeout(() => c.test.classList.remove('sent'), 1400);
        }
      },
    });
    c.kebab = h('button', {
      type: 'button', class: 'icon-btn', html: ICON.more, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => {
        closeMenus(c);
        c.menu.hidden = !c.menu.hidden;
        c.kebab.setAttribute('aria-expanded', String(!c.menu.hidden));
        if (!c.menu.hidden) c.menu.querySelector('button').focus();
      },
    });
    const dup = h('button', { type: 'button', role: 'menuitem', html: ICON.copy, onclick: () => (closeMenus(), duplicate(id)) });
    dup.append('Duplicate');
    const del = h('button', { type: 'button', role: 'menuitem', class: 'danger', text: 'Delete' });
    confirmButton(del, 'Click to confirm', () => (closeMenus(), app.call('deleteReminder', id)));
    c.menu = h('div', { class: 'menu', role: 'menu', hidden: true }, dup, del);
    c.menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenus();
        c.kebab.focus();
      }
    });
    c.el = h('article', { class: 'card' },
      h('div', { class: 'card-top' }, c.open, c.toggle),
      h('div', { class: 'card-foot' },
        h('span', { class: 'pill', html: ICON.clock }, c.next),
        h('span', { class: 'pill count' }, c.count, c.bar),
        h('div', { class: 'card-actions' }, c.test,
          h('div', { class: 'menu-wrap' }, c.kebab, c.menu))));
    return c;
  }

  function updateCard(c, r) {
    c.el.classList.toggle('off', !r.enabled);
    c.emoji.textContent = r.emoji;
    c.title.textContent = r.title;
    c.sub.textContent = scheduleText(r);
    c.open.setAttribute('aria-label', `Edit ${r.title}`);
    c.toggle.checked = r.enabled;
    c.toggle.setAttribute('aria-label', `${r.title} active`);
    c.test.setAttribute('aria-label', `Test ${r.title} on desktop`);
    c.test.title = 'Test on desktop';
    c.kebab.setAttribute('aria-label', `More for ${r.title}`);
    c.next.textContent = nextText(r);
    const yes = todayYes(r.id);
    c.count.textContent = r.goal ? `${yes} / ${r.goal} today` : `${yes} today`;
    c.bar.hidden = !r.goal;
    c.bar.firstChild.style.width = `${r.goal ? Math.min(100, (yes / r.goal) * 100) : 0}%`;
  }

  function renderCards() {
    const list = app.state.reminders;
    for (const [id, c] of cards) if (!list.some((r) => r.id === id)) (c.el.remove(), cards.delete(id));
    list.forEach((r, i) => {
      let c = cards.get(r.id);
      if (!c) cards.set(r.id, (c = createCard(r.id)));
      updateCard(c, r);
      if (cardsEl.children[i] !== c.el) cardsEl.insertBefore(c.el, cardsEl.children[i] || null);
    });
    $('#rem-empty', root).hidden = list.length > 0;
    cardsEl.hidden = !list.length;
    const newBtn = $('#rem-new', root);
    newBtn.disabled = atLimit();
    newBtn.title = atLimit() ? `You can have up to ${L.maxReminders} reminders` : '';
  }

  async function duplicate(id) {
    const r = find(id);
    if (!r) return;
    const title = glen(`${r.title} copy`) <= L.title ? `${r.title} copy` : r.title;
    const copy = { ...clone(r), id: crypto.randomUUID(), title };
    if (await app.call('saveReminder', copy)) toast(`Duplicated “${r.title}”`);
  }

  // ================= template gallery =================
  function openGallery() {
    if (atLimit()) return toast(`You can have up to ${L.maxReminders} reminders`, 'error');
    const vars = { name: app.state.settings.userName };
    $('#gallery-tiles').replaceChildren(...app.state.templates.map((t) =>
      h('button', { type: 'button', class: 'tpl', onclick: () => createFrom(t) },
        h('span', { class: 'tpl-emoji', text: t.emoji, 'aria-hidden': 'true' }),
        h('span', { class: 'tpl-title', text: t.title }),
        h('span', { class: 'tpl-q', text: fill(t.question, { ...vars, snooze: t.snooze, goal: t.goal }) }))));
    gallery.showModal();
  }
  async function createFrom(t) {
    const { key, ...rest } = clone(t);
    const r = { id: crypto.randomUUID(), enabled: true, avatarId: null, ...rest };
    if (!(await app.call('saveReminder', r))) return;
    gallery.close();
    openEditor(r.id);
  }
  $('#rem-new', root).addEventListener('click', openGallery);
  $('#rem-empty-new', root).addEventListener('click', openGallery);
  $('#gallery-close').addEventListener('click', () => gallery.close());
  gallery.addEventListener('click', (e) => e.target === gallery && gallery.close());

  // ================= editor: static parts =================
  const textField = (key) => {
    const { label, max, optional } = TEXT[key];
    return h('div', { class: 'field', 'data-field': key },
      h('div', { class: 'label-row' },
        h('label', { for: `f-${key}`, text: optional ? `${label} (optional)` : label }),
        h('span', { class: 'count', 'aria-hidden': 'true' })),
      h('input', { id: `f-${key}`, class: 'input', 'data-key': key, 'data-max': max }),
      h('p', { class: 'err', 'aria-live': 'polite' }));
  };
  $('#ed-basics', root).append(textField('title'));
  $('#ed-words', root).append(
    textField('greeting'), textField('question'),
    h('div', { class: 'two' }, textField('yesLabel'), textField('laterLabel')),
    textField('yesReply'), textField('laterReply'));
  $('#f-emoji').dataset.max = L.emoji;

  const emojiQuick = $('#emoji-quick', root);
  emojiQuick.append(...QUICK_EMOJI.map((e) => h('button', { type: 'button', class: 'emoji-btn', text: e, 'data-emoji': e, 'aria-label': e })));
  emojiQuick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    ed.draft.emoji = b.dataset.emoji;
    $('#f-emoji').value = b.dataset.emoji;
    changed();
  });

  const propTiles = $('#prop-tiles', root);
  const propIcon = (id) => {
    const svg = createPropIcon(id, ed.draft?.emoji, { size: 40 });
    if (id === 'none') svg.innerHTML = NONE_SVG;
    return svg;
  };
  propTiles.append(...PROPS.map((p) =>
    h('button', { type: 'button', role: 'radio', class: 'tile', 'data-value': p.id, title: p.name },
      propIcon(p.id), h('span', { text: PROP_LABELS[p.id] || p.name }))));
  const paintProp = (id) => $(`[data-value="${id}"] svg`, propTiles).replaceWith(propIcon(id));
  radioGroup(propTiles, (v) => {
    ed.draft.prop = v;
    setSeg(propTiles, v);
    changed();
  });

  const actionChips = $('#action-chips', root);
  actionChips.append(...ACTIONS.map((a) => h('button', { type: 'button', role: 'radio', class: 'chip', 'data-value': a.id, text: `${ACTION_ICONS[a.id] || '✨'} ${a.name}` })));
  radioGroup(actionChips, (v) => {
    ed.draft.action = v;
    setSeg(actionChips, v);
    changed();
  });

  const modeSeg = $('#f-mode', root);
  radioGroup(modeSeg, (v) => {
    const s = ed.draft.schedule;
    s.mode = v;
    if (v === 'times' && !s.times.length) s.times.push('10:00');
    paintSchedule();
    changed();
  });

  $('#every-presets', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-every]');
    if (!b) return;
    ed.draft.schedule.every = Number(b.dataset.every);
    $('#f-every').value = b.dataset.every;
    changed();
  });

  const daysEl = $('#f-days', root);
  daysEl.append(...DAY_LETTERS.map((l, i) => h('button', { type: 'button', class: 'day', 'data-day': i, 'aria-label': DAY_FULL[i], text: l })));
  daysEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const s = ed.draft.schedule;
    const d = Number(b.dataset.day);
    s.days = s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort();
    paintDays();
    changed();
  });
  for (const b of $$('[data-days]', root)) {
    b.addEventListener('click', () => {
      ed.draft.schedule.days = [...b.dataset.days].map(Number);
      paintDays();
      changed();
    });
  }

  const timesEl = $('#f-times', root);
  function paintTimes() {
    const s = ed.draft.schedule;
    timesEl.replaceChildren(...s.times.map((t, i) =>
      h('div', { class: 'time-item' },
        h('input', { type: 'time', class: 'input time', value: t, 'data-key': 'time', 'data-index': i, 'aria-label': `Time ${i + 1}` }),
        h('button', {
          type: 'button', class: 'icon-btn', html: ICON.x, 'aria-label': `Remove time ${i + 1}`, disabled: s.times.length <= 1,
          onclick: () => (s.times.splice(i, 1), paintTimes(), changed()),
        }))));
    if (s.times.length < L.maxTimes) {
      const add = h('button', { type: 'button', class: 'chip add', html: ICON.plus });
      add.append('Add time');
      add.addEventListener('click', () => {
        const last = [...s.times].filter((t) => HM.test(t)).sort().pop() || '09:00';
        const m = Math.min(23 * 60 + 59, Number(last.slice(0, 2)) * 60 + Number(last.slice(3)) + 60);
        s.times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
        paintTimes();
        changed();
        $$('input', timesEl).pop().focus();
      });
      timesEl.append(add);
    }
  }

  // placeholder chips insert at the caret of the last focused text field
  form.addEventListener('focusin', (e) => {
    if (e.target.matches('#ed-words input')) ed.lastText = e.target;
  });
  const phBar = $('#ph-bar', root);
  phBar.addEventListener('mousedown', (e) => e.target.closest('.ph') && e.preventDefault());
  phBar.addEventListener('click', (e) => {
    const b = e.target.closest('.ph');
    if (!b) return;
    const el = ed.lastText || $('#f-question');
    const start = el.selectionStart ?? el.value.length;
    el.focus();
    el.setRangeText(b.dataset.ph, start, el.selectionEnd ?? start, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    const el = e.target;
    const key = el.dataset.key;
    if (!key || !ed.draft) return;
    const d = ed.draft;
    const s = d.schedule;
    if (key in TEXT) d[key] = el.value;
    else if (key === 'every') s.every = num(el.value);
    else if (key === 'from' || key === 'to') s[key] = el.value;
    else if (key === 'time') s.times[Number(el.dataset.index)] = el.value;
    else if (key === 'snooze' || key === 'goal') d[key] = num(el.value);
    else if (key === 'avatarId') d.avatarId = el.value || null;
    changed();
  });

  $('#ed-enabled', root).addEventListener('change', (e) => {
    ed.draft.enabled = e.target.checked;
    changed();
  });
  $('#ed-back', root).addEventListener('click', () => closeEditor());
  editorEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('.menu') && !gallery.open) closeEditor();
  });
  confirmButton($('#ed-delete', root), 'Click again to delete', async () => {
    const id = ed.id;
    closeEditor({ discard: true });
    if (await app.call('deleteReminder', id)) toast('Reminder deleted');
  });
  $('#pv-yes', root).addEventListener('click', () => ed.preview?.yes());
  $('#pv-later', root).addEventListener('click', () => ed.preview?.later());
  $('#pv-replay', root).addEventListener('click', () => ed.preview?.replay());
  $('#pv-test', root).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const errs = validate(ed.draft);
    if (Object.keys(errs).length) return toast('Fix the highlighted fields first', 'error');
    if (await app.call('testReminder', cleanDraft(ed.draft))) {
      btn.classList.add('sent');
      setTimeout(() => btn.classList.remove('sent'), 1400);
    }
  });

  // ================= editor: state =================
  const chip = $('#ed-save', root);
  function setChip(state, text) {
    chip.dataset.state = state;
    chip.textContent = text;
  }

  const save = debounce(async () => {
    const { id, rev } = ed;
    const res = await app.call('saveReminder', cleanDraft(ed.draft));
    if (ed.id !== id) return;
    if (!res) setChip('error', 'Not saved');
    else if (rev === ed.rev) setChip('saved', 'Saved ✓');
  }, 450);

  function paintDays() {
    for (const b of $$('.day', daysEl)) b.setAttribute('aria-pressed', String(ed.draft.schedule.days.includes(Number(b.dataset.day))));
  }
  function paintSchedule() {
    const s = ed.draft.schedule;
    setSeg(modeSeg, s.mode);
    $('#mode-interval', root).hidden = s.mode !== 'interval';
    $('#mode-times', root).hidden = s.mode !== 'times';
    paintTimes();
  }
  function paintAvatarOptions() {
    const st = app.state.settings;
    const sel = $('#f-avatar', root);
    sel.replaceChildren(
      h('option', { value: '', text: `Same as Buddy tab (${buddyName(st.avatarId)})` }),
      h('option', { value: 'nova', text: buddyName('nova') }),
      ...(app.state.meta.avatarModelUrl ? [h('option', { value: 'me3d', text: 'My 3D avatar' })] : []));
    sel.value = ed.draft.avatarId && (ed.draft.avatarId !== 'custom' || st.customAvatar) ? ed.draft.avatarId : '';
  }

  /** Everything derived from the draft that is not an input value the user is typing into. */
  function paintDerived() {
    const d = ed.draft;
    $('#ed-emoji', root).textContent = d.emoji;
    $('#ed-title', root).textContent = d.title.trim() || 'Untitled reminder';
    for (const b of $$('[data-emoji]', emojiQuick)) b.setAttribute('aria-pressed', String(b.dataset.emoji === d.emoji));
    for (const b of $$('[data-every]', root)) b.setAttribute('aria-pressed', String(Number(b.dataset.every) === d.schedule.every));
    $('#goal-unit', root).textContent = d.goal ? 'times a day' : 'off';
    paintProp('emoji');
  }

  function paintErrors() {
    const errs = validate(ed.draft);
    for (const f of $$('[data-field]', form)) {
      const msg = errs[f.dataset.field] || '';
      f.classList.toggle('invalid', !!msg);
      $('.err', f).textContent = msg;
      for (const i of $$('input', f)) i.setAttribute('aria-invalid', String(!!msg));
    }
    for (const i of $$('[data-max]', form)) {
      const n = glen(i.value);
      const c = $('.count', i.closest('.field'));
      if (c) {
        c.textContent = `${n}/${i.dataset.max}`;
        c.classList.toggle('over', n > Number(i.dataset.max));
      }
    }
    return Object.keys(errs).length;
  }

  function changed() {
    ed.rev++;
    paintDerived();
    const bad = paintErrors();
    ed.preview?.update();
    if (bad) {
      save.cancel();
      setChip('invalid', bad === 1 ? 'Fix 1 field to save' : `Fix ${bad} fields to save`);
    } else {
      setChip('pending', 'Saving…');
      save();
    }
  }

  function openEditor(id) {
    const r = find(id);
    if (!r) return;
    closeMenus();
    Object.assign(ed, { id, draft: clone(r), rev: 0, lastText: null });
    const d = ed.draft;
    for (const key of Object.keys(TEXT)) $(`#f-${key}`).value = d[key];
    $('#f-every').value = d.schedule.every;
    $('#f-from').value = d.schedule.from;
    $('#f-to').value = d.schedule.to;
    $('#f-snooze').value = d.snooze;
    $('#f-goal').value = d.goal;
    $('#ed-enabled').checked = d.enabled;
    paintProp('emoji');
    setSeg(propTiles, d.prop);
    setSeg(actionChips, d.action);
    paintSchedule();
    paintDays();
    paintAvatarOptions();
    paintDerived();
    paintErrors();
    setChip('saved', 'Saved ✓');
    listView.hidden = true;
    editorEl.hidden = false;
    $('#main').scrollTop = 0;
    ed.preview = createPreview($('#pv-stage', root), app, () => ed.draft);
    $('#ed-back', root).focus();
  }

  function closeEditor({ discard = false } = {}) {
    if (!ed.id) return;
    const id = ed.id;
    if (discard) save.cancel();
    else if (chip.dataset.state === 'invalid') toast('Your last edits had errors, so they weren’t saved', 'error');
    else save.flush();
    ed.preview?.destroy();
    Object.assign(ed, { id: null, draft: null, preview: null });
    editorEl.hidden = true;
    listView.hidden = false;
    renderCards();
    cards.get(id)?.open.focus();
  }

  app.onState((st) => {
    if (ed.id) {
      if (!st.reminders.some((r) => r.id === ed.id)) {
        closeEditor({ discard: true });
        toast('That reminder was removed');
      } else {
        paintAvatarOptions();
        ed.preview?.update();
      }
    }
    renderCards();
  });

  return {
    activate: renderCards,
    deactivate: () => closeEditor(),
    home: () => closeEditor(),
    tick() {
      if (ed.id) return;
      for (const r of app.state.reminders) {
        const c = cards.get(r.id);
        const t = c && nextText(r);
        if (c && c.next.textContent !== t) c.next.textContent = t;
      }
    },
  };
}
