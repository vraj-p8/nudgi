// Bubble Lab: drives one bubble per "screen" so every state can be compared side by side.
import '../shared/mock-api.js';
import { createBubble } from '../shared/bubble.js';
import { sfx, speak, stopSpeaking, preferredVoice, SFX_NAMES } from '../shared/sound.js';
import { fill } from '../shared/text.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const appState = await window.nudge.getState();
const templates = appState.templates;
const lab = {
  style: 'comic',
  accent: '#12b5d0',
  template: templates[0],
  count: 3,
  vars: { name: appState.settings.userName, buddy: 'Nova', snooze: 15, count: 3, goal: 8, title: 'Drink water' },
};

// ---- busy code-editor background ------------------------------------------------------------
const CODE = `import { powerMonitor } from 'electron';
// Fires reminders on wall-clock time so sleep/resume never drifts.
export class Scheduler {
  constructor(store, { tickMs = 10000 } = {}) {
    this.store = store;
    this.tickMs = tickMs;
    this.timer = null;
  }
  start() {
    this.timer = setInterval(() => this.tick(Date.now()), this.tickMs);
    powerMonitor.on('resume', () => this.tick(Date.now()));
  }
  tick(now) {
    for (const r of this.store.reminders) {
      const due = this.store.runtime.next[r.id];
      if (!r.enabled || due == null || due > now) continue;
      if (this.blocked(now)) return; // stays due, fires once later
      this.fire(r, now);
    }
  }
  computeNext(reminder, fromMs) {
    const { mode, every, times } = reminder.schedule;
    return mode === 'times' ? nextTime(times, fromMs) : fromMs + every * 60000;
  }
}`;
const KW = /\b(import|from|export|class|constructor|const|let|return|for|of|if|continue|this|new|null)\b/;
function renderCode() {
  const host = $('#ideCode');
  CODE.split('\n').forEach((line, i) => {
    const row = document.createElement('div');
    if (i === 14) row.className = 'cur';
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = String(i + 1);
    row.append(ln);
    const re = /(\/\/.*$)|('[^']*')|(\b\d+\b)|(\b[A-Za-z_]\w*)(?=\()|(\b[A-Za-z_]\w*\b)|(\s+|.)/g;
    let m;
    while ((m = re.exec(line))) {
      const s = document.createElement('span');
      s.textContent = m[0];
      if (m[1]) s.className = 'tk-m';
      else if (m[2]) s.className = 'tk-s';
      else if (m[3]) s.className = 'tk-n';
      else if (m[4]) s.className = KW.test(m[4]) ? 'tk-k' : 'tk-f';
      else if (m[5]) s.className = /^(import|from|export|return|for|of|if|continue)$/.test(m[5]) ? 'tk-c' : KW.test(m[5]) ? 'tk-k' : 'tk-v';
      row.append(s);
    }
    host.append(row);
  });
  const tree = $('#ideTree');
  [['NUDGE-BUDDY', 0], ['src', 0], ['main', 1], ['main.js', 2], ['scheduler.js', 2, true], ['store.js', 2], ['tray.js', 2],
    ['renderer', 1], ['overlay', 2], ['settings', 2], ['shared', 2], ['test', 0], ['package.json', 0]].forEach(([name, depth, on]) => {
    const d = document.createElement('div');
    d.textContent = name;
    d.style.setProperty('--depth', depth);
    if (on) d.className = 'on';
    tree.append(d);
  });
  const mini = $('#ideMini');
  const hues = ['#569cd6', '#9cdcfe', '#ce9178', '#6a9955', '#dcdcaa', '#c586c0'];
  CODE.split('\n').forEach((line, i) => {
    const bar = document.createElement('i');
    bar.style.width = `${Math.min(100, line.length * 1.6)}%`;
    bar.style.marginLeft = `${(line.length - line.trimStart().length) * 1.6}%`;
    bar.style.color = hues[i % hues.length];
    mini.append(bar);
  });
}
renderCode();

// ---- stages ---------------------------------------------------------------------------------
const PUCK_SVG = `<svg viewBox="0 0 44 54" aria-hidden="true">
  <path d="M22 1.5c1.3 1.7 19 19.6 19 32.2a19 19 0 0 1-38 0C3 21.1 20.7 3.2 22 1.5Z" fill="#27c2dc"/>
  <path d="M22 1.5c1.3 1.7 19 19.6 19 32.2a19 19 0 0 1-3.2 10.6C39 26 22 8 22 1.5Z" fill="#0c93b3" opacity=".55"/>
  <ellipse cx="14.5" cy="27" rx="4" ry="6" fill="#fff" opacity=".7" transform="rotate(20 14.5 27)"/>
  <circle cx="16" cy="36" r="2.6" fill="#10213a"/><circle cx="28" cy="36" r="2.6" fill="#10213a"/>
  <path d="M19 41.5q3 2.4 6 0" stroke="#10213a" stroke-width="1.8" fill="none" stroke-linecap="round"/>
</svg>`;

const stages = $$('.stage').map((el) => {
  const puck = document.createElement('div');
  puck.className = 'puck';
  puck.innerHTML = PUCK_SVG;
  puck.title = 'Drag to move the anchor';
  const dot = document.createElement('div');
  dot.className = 'puck-dot';
  el.append(puck, dot);
  const st = { el, puck, dot, bg: el.dataset.bg, ax: 0.62, ay: 0.78, bubble: null };
  st.bubble = createBubble(el, { style: lab.style, accent: lab.accent });
  st.bubble.onAnswer((outcome) => onAnswer(st, outcome));
  dragPuck(st);
  return st;
});

function place(st) {
  const w = st.el.clientWidth;
  const hgt = st.el.clientHeight;
  let x = Math.round(st.ax * w);
  let y = Math.round(st.ay * hgt);
  if (st.av) {
    // the real buddy stands on the bottom edge; its head-top anchor drives the bubble
    st.av.x = Math.min(w - st.av.width, Math.max(0, x - st.av.width / 2));
    ({ x, y } = st.av.anchor('top'));
  }
  st.puck.style.translate = `${x}px ${y}px`;
  st.dot.style.translate = `${x}px ${y}px`;
  st.bubble.placeAbove(x, y, { width: w, height: hgt });
}
const placeAll = () => stages.forEach(place);
new ResizeObserver(() => requestAnimationFrame(placeAll)).observe($('#stages'));
placeAll();

function dragPuck(st) {
  st.puck.addEventListener('pointerdown', (e) => {
    st.puck.setPointerCapture(e.pointerId);
    st.puck.classList.add('dragging');
    const r = st.el.getBoundingClientRect();
    const move = (ev) => {
      st.ax = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      st.ay = Math.min(0.97, Math.max(0.03, (ev.clientY - r.top) / r.height));
      place(st);
    };
    const up = () => {
      st.puck.classList.remove('dragging');
      st.puck.removeEventListener('pointermove', move);
    };
    st.puck.addEventListener('pointermove', move);
    st.puck.addEventListener('pointerup', up, { once: true });
    st.puck.addEventListener('pointercancel', up, { once: true });
  });
}

// ---- texts ----------------------------------------------------------------------------------
const fields = ['greeting', 'question', 'yesLabel', 'laterLabel'];
const tplSelect = $('#template');
for (const t of templates) {
  const o = document.createElement('option');
  o.value = t.key;
  o.textContent = `${t.emoji} ${t.title}`;
  tplSelect.append(o);
}
function loadTemplate(key) {
  lab.template = templates.find((t) => t.key === key) || templates[0];
  lab.vars.snooze = lab.template.snooze;
  lab.vars.title = lab.template.title;
  for (const f of fields) $(`#${f}`).value = fill(lab.template[f], lab.vars);
}
tplSelect.addEventListener('change', () => loadTemplate(tplSelect.value));
loadTemplate('water');

const texts = () => Object.fromEntries(fields.map((f) => [f, $(`#${f}`).value]));
const replyText = (key) => fill(lab.template[key], lab.vars);

// ---- actions --------------------------------------------------------------------------------
const log = (st, msg) => {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = st ? st.bg : 'lab';
  li.append(b, ` ${msg}`);
  $('#log').prepend(li);
};
// In focus mode only the focused screen plays; otherwise every screen that is shown.
const visible = (s) => {
  const focused = $('.stage.is-focus');
  return focused ? s.el === focused : !!s.el.offsetParent;
};
const each = (fn) => Promise.all(stages.filter(visible).map(fn));

function showAll(opts = {}, { silent = false } = {}) {
  stopCountdown();
  if (!silent) sfx.play('chime');
  return each((st) => {
    if (st.av) {
      st.av.setMood('neutral');
      st.av.pose('present');
    }
    return st.bubble.show({
      ...texts(),
      closable: true,
      onTalk: (ms) => {
        st.av?.say(ms);
        if (st === stages.find(visible)) log(null, `onTalk(${ms} ms)`);
      },
      ...opts,
    });
  });
}

// ---- optional real buddy --------------------------------------------------------------------
let engine = null;
async function setRealBuddy(on) {
  if (on && !engine) {
    try {
      engine = await import('../shared/avatar-engine.js');
    } catch (err) {
      log(null, `avatar engine unavailable: ${err.message}`);
      $('#realBuddy').checked = false;
      return;
    }
  }
  for (const st of stages) {
    if (on && !st.av) {
      st.av = engine.createAvatar(st.el, { avatarId: 'nova', height: 250, prop: 'bottle', emoji: '💧' });
      st.av.pose('present');
    } else if (!on && st.av) {
      st.av.destroy();
      st.av = null;
    }
    st.puck.hidden = on;
  }
  placeAll();
}
$('#realBuddy').addEventListener('change', (e) => setRealBuddy(e.target.checked));
// eyes follow the cursor, like on the desktop
document.addEventListener('pointermove', (e) => stages.forEach((st) => st.av?.lookAt(e.clientX, e.clientY)));

function goalReply(st, count) {
  const done = count >= 8;
  return st.bubble.reply(replyText('yesReply'), {
    mood: 'happy',
    goal: { count, total: 8, shape: lab.template.prop === 'bottle' || lab.template.prop === 'glass' ? 'drop' : 'dot' },
    extra: done ? 'Goal reached! 🎉' : null,
  });
}

async function onAnswer(st, outcome) {
  log(st, `answered → ${outcome}`);
  if (!$('#autoReply').checked) return;
  stopCountdown();
  if (st.av) {
    st.av.setMood(outcome === 'later' ? 'sad' : 'happy');
    st.av.pose(outcome === 'later' ? 'sad' : 'happy');
  }
  if (outcome === 'yes') {
    sfx.play('happy');
    lab.count = Math.min(8, lab.count + 1);
    syncCount();
    await goalReply(st, lab.count);
    if (lab.count >= 8) sfx.play('sparkle');
  } else if (outcome === 'later') {
    sfx.play('sad');
    await st.bubble.reply(replyText('laterReply'), { mood: 'sad' });
  } else {
    sfx.play('whoosh');
    await st.bubble.hide();
  }
}

function syncCount() {
  $('#goalCount').textContent = `${lab.count}/8`;
}

let countdownTimer = 0;
function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = 0;
  stages.forEach((s) => s.bubble.setCountdown(0));
}

const ACTIONS = {
  show: () => showAll(),
  instant: () => showAll({ instant: true }),
  happy: () => (sfx.play('happy'), each((st) => st.bubble.reply(replyText('yesReply'), { mood: 'happy' }))),
  sad: () => (sfx.play('sad'), each((st) => st.bubble.reply(replyText('laterReply'), { mood: 'sad' }))),
  streak: () => {
    sfx.play('sad');
    sfx.play('thunder');
    return each((st) => st.bubble.reply(replyText('laterReply'), { mood: 'sad', extra: 'Again? 🥺' }));
  },
  neutral: () => each((st) => st.bubble.reply("I'll check back soon 👋", { mood: 'neutral' })),
  goal: () => {
    lab.count = lab.count >= 8 ? 1 : lab.count + 1;
    syncCount();
    sfx.play('happy');
    return each((st) => goalReply(st, lab.count));
  },
  goalDone: () => {
    lab.count = 8;
    syncCount();
    sfx.play('happy');
    setTimeout(() => sfx.play('sparkle'), 700);
    return each((st) => goalReply(st, 8));
  },
  countdown: async () => {
    await showAll({ instant: true });
    stopCountdown();
    const start = performance.now();
    countdownTimer = setInterval(() => {
      const f = Math.min(1, (performance.now() - start) / 8000);
      stages.forEach((s) => s.bubble.setCountdown(f));
      if (f >= 1) {
        stopCountdown();
        each((st) => st.bubble.reply("I'll check back soon 👋", { mood: 'neutral' }));
      }
    }, 100);
  },
  hide: () => (stopCountdown(), each((st) => st.bubble.hide())),
  run: async () => {
    await showAll();
    await wait(900);
    sfx.play('happy');
    lab.count = Math.min(8, lab.count + 1);
    syncCount();
    await each((st) => goalReply(st, lab.count));
    await wait(1600);
    sfx.play('whoosh');
    await each((st) => st.bubble.hide());
  },
  long: () => {
    $('#greeting').value = 'Good afternoon, Alexandria-Rose! Quick check-in from me 👋';
    $('#question').value = "It's been a while since your last glass — could you grab some water before the next call?";
    $('#yesLabel').value = 'Yes, drinking now!';
    $('#laterLabel').value = 'Remind me in a bit';
    return showAll();
  },
  emoji: () => {
    $('#greeting').value = `Hey 👋🏽 ${lab.vars.name}! 🎈`;
    $('#question').value = 'Water 💧, tea 🍵 or a smoothie 🥤? Family time 👨‍👩‍👧 counts too ❤️';
    return showAll();
  },
  zoom: () => {
    const z = document.body.style.zoom === '3' ? '' : '3';
    document.body.style.zoom = z;
    requestAnimationFrame(placeAll);
  },
  motion: () => log(null, `prefers-reduced-motion: ${matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'}`),
  speak: () => speak(`${$('#greeting').value}. ${$('#question').value}`, { enabled: true, volume: sfx.volume }),
  hush: () => stopSpeaking(),
};

function focusStage(st) {
  for (const s of stages) s.el.classList.toggle('is-focus', s === st && !s.el.classList.contains('is-focus'));
  requestAnimationFrame(placeAll);
}
stages.forEach((st) => $('.stage-tag', st.el).addEventListener('click', () => focusStage(st)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('.stage.is-focus')) focusStage(null);
});

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act && ACTIONS[act.dataset.act]) ACTIONS[act.dataset.act]();
  const anchor = e.target.closest('[data-anchor]');
  if (anchor) {
    const spot = { left: [0.03, 0.78], center: [0.5, 0.78], right: [0.97, 0.78], high: [0.62, 0.12] }[anchor.dataset.anchor];
    stages.forEach((st) => ([st.ax, st.ay] = spot));
    placeAll();
  }
});

// ---- look -----------------------------------------------------------------------------------
$('#style').addEventListener('click', (e) => {
  const b = e.target.closest('[data-value]');
  if (!b) return;
  lab.style = b.dataset.value;
  $$('#style [role="radio"]').forEach((r) => r.setAttribute('aria-checked', String(r === b)));
  stages.forEach((st) => st.bubble.setStyle(lab.style));
  requestAnimationFrame(placeAll);
});
$('#accent').addEventListener('input', (e) => {
  lab.accent = e.target.value;
  stages.forEach((st) => st.bubble.setAccent(lab.accent));
});
$('#screens').addEventListener('change', (e) => {
  $('#stages').dataset.show = e.target.value;
  requestAnimationFrame(placeAll);
});

// ---- sound ----------------------------------------------------------------------------------
const sfxGrid = $('#sfx');
for (const name of SFX_NAMES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.addEventListener('click', () => {
    sfx.play(name);
    drawWave(name);
  });
  sfxGrid.append(b);
}

// Offline-renders the effect and plots it, so loudness/length can be checked by eye.
async function drawWave(name) {
  const buf = await sfx.render(name);
  if (!buf) return;
  const data = buf.getChannelData(0);
  let peak = 0;
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    if (a > 0.001) last = i;
  }
  const canvas = $('#wave');
  const g = canvas.getContext('2d');
  const { width: w, height: hgt } = canvas;
  g.clearRect(0, 0, w, hgt);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  const step = Math.ceil(data.length / w);
  for (let x = 0; x < w; x++) {
    let lo = 0;
    let hi = 0;
    for (let i = x * step; i < Math.min(data.length, (x + 1) * step); i++) {
      lo = Math.min(lo, data[i]);
      hi = Math.max(hi, data[i]);
    }
    // full height = -12 dBFS, so relative loudness between effects stays comparable
    g.fillRect(x, hgt / 2 - Math.min(1, hi / 0.25) * hgt * 0.48, 1, Math.max(1, Math.min(2, (hi - lo) / 0.25) * hgt * 0.48));
  }
  const db = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '-∞';
  $('#waveNote').textContent = `${name}: peak ${db} dBFS · audible ${(last / buf.sampleRate).toFixed(2)} s · volume ${sfx.volume}`;
}
sfx.enabled = $('#soundOn').checked;
sfx.volume = Number($('#volume').value);
$('#soundOn').addEventListener('change', (e) => (sfx.enabled = e.target.checked));
$('#volume').addEventListener('input', (e) => (sfx.volume = Number(e.target.value)));

async function describeVoice() {
  const v = await preferredVoice();
  $('#voiceNote').textContent = v ? `Voice: ${v.name} (${v.lang})` : 'Voice: no English voice available.';
}
window.speechSynthesis?.addEventListener('voiceschanged', describeVoice);
describeVoice();

// First impression: everything visible on load (silent: audio needs a user gesture first).
await wait(250);
showAll({}, { silent: true });
