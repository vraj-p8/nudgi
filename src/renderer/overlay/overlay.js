// Nudgi overlay - the director. Receives one run at a time from main (nudge.onRun) and choreographs it:
// entrance → present + bubble (configured texts only) → answer → reaction → exit toward the nearest edge.
// Every run sends exactly one nudge.respond(runId, outcome) and then nudge.runDone(runId).
// The window is click-through; pointer moves are forwarded by main and hit-tested here (nudge.setInteractive).
import '../shared/mock-api.js';
import { createAvatar } from '../shared/avatar-engine.js';
import { createBubble } from '../shared/bubble.js';
import { sfx, speak, stopSpeaking } from '../shared/sound.js';
import { fill } from '../shared/text.js';

const nudge = window.nudge;
const stage = document.getElementById('stage');

const SIZE_PX = { s: 250, m: 360, l: 440 };
const GROUND = 10; // breathing room above the work-area bottom (taskbar)
const MOOD_SPEED = { neutral: 1, happy: 1.16, sad: 0.6 }; // engine walk speeds, × height/2 px per second
const ABORT = Symbol('abort');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Read-only diagnostics for the Electron verification runner and avatar studio.
export function inspectOverlay() {
  return { phase: current?.phase, action: av?.action, busy: av?.busy, x: av?.x, ready: av?.ready, rig: av?.inspect?.() };
}
const readMs = (text) => clamp(1300 + String(text).length * 45, 1800, 4200);

let av = null;
let current = null; // the active run controller
let pendingRun = null; // defensive: a run that arrived while another was still on screen
let interactive = false;
const pointer = { x: -1, y: -1, inside: false };
const pet = { since: 0, last: 0, cooldown: 0 };
let pokeCooldown = 0;

const bubble = createBubble(stage, { style: 'comic' });
bubble.onAnswer((outcome) => current?.answer(outcome));

// ------------------------------------------------------------------------------------------------ run plumbing
function makeController(run) {
  let abortResolve;
  let answerResolve;
  const ctl = {
    run,
    phase: 'enter',
    outcome: null,
    responded: false,
    aborted: false,
    timers: new Set(),
    abortP: new Promise((resolve) => (abortResolve = resolve)),
    answerP: null,
    answer(outcome) {
      if (ctl.outcome || ctl.aborted) return;
      ctl.outcome = outcome;
      answerResolve(outcome);
    },
    abort() {
      ctl.aborted = true;
      abortResolve();
    },
    later(fn, ms) {
      const id = setTimeout(() => {
        ctl.timers.delete(id);
        fn();
      }, ms);
      ctl.timers.add(id);
    },
  };
  ctl.answerP = new Promise((resolve) => (answerResolve = resolve));
  return ctl;
}

// Awaits `p` unless the run is aborted meanwhile (then unwinds the director with ABORT).
function guard(ctl, p) {
  return Promise.race([p, ctl.abortP]).then((v) => {
    if (ctl.aborted) throw ABORT;
    return v;
  });
}

function respondOnce(ctl, outcome) {
  if (ctl.responded) return;
  ctl.responded = true;
  nudge.respond(ctl.run.runId, outcome);
}

function setPhase(ctl, phase) {
  ctl.phase = phase;
  if (phase === 'exit') setInteractive(false);
  else updateHit();
}

function start(run) {
  current = makeController(run);
  perform(current);
}

nudge.onRun((run) => {
  if (!run || !run.runId) return;
  if (current) {
    pendingRun = run;
    current.abort();
    return;
  }
  start(run);
});

// ------------------------------------------------------------------------------------------------ stage setup
function prepare(run) {
  const { avatar, settings, reminder } = run;
  const height = SIZE_PX[settings.size] || SIZE_PX.m;
  const id = avatar.id || 'nova';
  if (!av) {
    av = createAvatar(stage, { avatarId: id, customUrl: avatar.customUrl, color: avatar.color, height });
    av.on('step', () => sfx.play('step', { pan: pan() }));
    av.on('flash', () => sfx.play('thunder', { pan: pan() }));
  } else {
    av.setAvatar(id, avatar.customUrl);
    av.setHeight(height);
    av.setColor(avatar.color);
  }
  av.stop();
  av.fx('clear');
  av.setProp(reminder.prop || 'none', reminder.emoji);
  av.setMood('neutral');
  av.pose('idle', { duration: 1 });
  av.setFacing(0);
  av.lookAt(null);
  av.timeScale = 1;

  bubble.setStyle(settings.bubbleStyle);
  bubble.setAccent(avatar.color || av.def.colors?.primary || null);
  sfx.enabled = !!settings.sound;
  sfx.volume = settings.volume ?? 0.6;
  interactive = false; // main resets the window to click-through for every new run
}

const pan = () => (av ? clamp(((av.x + av.width / 2) / Math.max(1, stage.clientWidth)) * 2 - 1, -1, 1) * 0.6 : 0);

function walkSpeed(dist, secs, mood = 'neutral') {
  const base = av.height * 0.5 * MOOD_SPEED[mood];
  return Math.max(base, dist / (secs * (reduced() ? 0.6 : 1)));
}

// The bubble's exit is a short WAAPI animation; a stalled compositor must never hold the buddy on screen.
const hideBubble = (ctl) => guard(ctl, Promise.race([bubble.hide(), sleep(700)]));

// Where the buddy stands: its centre ≈ max(220, 1.2 × width) in from the chosen side.
function standX(side) {
  const W = stage.clientWidth;
  const w = av.width;
  const reach = Math.max(220, w * 1.2);
  return Math.round(clamp(side === 'left' ? reach : W - reach, w / 2 + 16, W - w / 2 - 16) - w / 2);
}

function placeBubble() {
  const top = av.anchor('top');
  bubble.placeAbove(Math.round(top.x), Math.round(top.y - 6 * (av.height / 250)), {
    width: stage.clientWidth,
    height: stage.clientHeight,
  });
}

// ------------------------------------------------------------------------------------------------ the run
async function perform(ctl) {
  const { run } = ctl;
  try {
    prepare(run);
    const s = run.settings;
    const r = run.reminder;
    const welcome = run.kind === 'welcome';
    // {buddy} is how the buddy introduces itself; an imported 3D avatar is the user's own twin, not "Me".
    const vars = { ...run.vars, buddy: av.avatarId === 'me3d' ? 'your 3D twin' : av.def.name };
    const say = (key) => fill(r[key], vars).trim();

    await enter(ctl, s);

    // ---- arrive & ask ----
    setPhase(ctl, 'arrive');
    av.setFacing(0);
    const hour = new Date().getHours();
    const night = hour >= 22 || hour < 6;
    if (!night && hour < 10 && !reduced()) await guard(ctl, av.play('stretch'));
    await guard(ctl, av.pose('present', { duration: 420 }));
    placeBubble();
    sfx.play('chime');
    const greeting = say('greeting');
    const question = say('question');
    if (s.voice) {
      const spoken = greeting && question ? `${greeting}${/[.!?…,]$/.test(greeting) ? '' : ','} ${question}` : greeting || question;
      speak(spoken, { enabled: true, volume: s.volume }).catch(() => {});
    }
    const shown = bubble.show({
      greeting,
      question,
      yesLabel: say('yesLabel'),
      laterLabel: say('laterLabel'),
      closable: true,
      onTalk: (ms) => av.say(ms),
    });
    setPhase(ctl, 'ask');
    shown.then(() => countdown(ctl, Number(s.autoDismissSec) || 0));
    scheduleIdle(ctl, night);

    const outcome = await guard(ctl, ctl.answerP);
    stopSpeaking();
    respondOnce(ctl, outcome);
    setPhase(ctl, 'react');

    if (outcome === 'yes') await reactYes(ctl, r, vars, say, welcome);
    else if (outcome === 'later') await (welcome ? reactCustomize(ctl, say) : reactLater(ctl, say, vars));
    else if (outcome === 'timeout') await reactTimeout(ctl, say, welcome);
    else await reactDismiss(ctl);
  } catch (err) {
    if (err !== ABORT) console.error('[overlay] run failed', err);
  } finally {
    finish(ctl);
  }
}

function finish(ctl) {
  for (const id of ctl.timers) clearTimeout(id);
  ctl.timers.clear();
  stopSpeaking();
  respondOnce(ctl, 'dismiss'); // only if nothing was answered (error / superseded run)
  setInteractive(false);
  if (av) {
    av.stop();
    av.fx('clear');
    av.lookAt(null);
    av.el.style.visibility = 'hidden';
  }
  bubble.hide();
  current = null;
  nudge.runDone(ctl.run.runId);
  if (pendingRun) {
    const next = pendingRun;
    pendingRun = null;
    start(next);
  }
}

// ------------------------------------------------------------------------------------------------ entrances
async function enter(ctl, s) {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const w = av.width;
  const k = av.height / 250;
  const left = s.side === 'left';
  const stand = standX(s.side);
  const dir = left ? 1 : -1; // travel direction while entering
  const offX = left ? -w * 1.35 : W + w * 0.35;

  let kind = s.entrance;
  if (kind !== 'walk' && kind !== 'drop' && kind !== 'peek') {
    const p = Math.random();
    kind = p < 0.5 ? 'walk' : p < 0.75 ? 'drop' : 'peek';
  }

  if (kind === 'drop') {
    av.x = stand;
    av.y = H + av.height * 0.4;
    // Establish the overhead grip while offscreen so loading and pose settling stay invisible.
    await guard(ctl, av.pose('umbrella', { duration: reduced() ? 120 : 500 }));
    av.el.style.visibility = '';
    sfx.play('whoosh', { pan: pan() });
    const descentMs = clamp((H + av.height * 0.4 - GROUND) / (av.height * 1.35) * 1000, 1800, 2300);
    await guard(ctl, av.glideTo({ y: GROUND }, { ms: descentMs * (reduced() ? 0.6 : 1), ease: 'canopy', sway: reduced() ? 0 : 14 }));
    sfx.play('step', { pan: pan() });
    await guard(ctl, av.play('land', { umbrella: true }));
    await guard(ctl, av.play('throwUmbrella', { dir: left ? -1 : 1 }));
    // Kai's base pose still holds the canopy grip; settle it now that the umbrella is gone.
    if (!av.is3D) av.pose('idle', { duration: 420 });
    return;
  }

  av.y = GROUND;
  av.x = offX;
  av.setFacing(dir);
  // Settle the previous exit and orient offscreen before revealing the next entrance.
  await guard(ctl, av.pose(kind === 'peek' ? 'peek' : 'idle', { duration: reduced() ? 120 : 420 }));
  av.el.style.visibility = '';
  if (kind === 'peek') {
    const peekX = left ? -w * 0.55 : W - w * 0.45;
    await av.pose('peek', { duration: 1 });
    await guard(ctl, av.glideTo({ x: peekX }, { ms: 650, ease: 'out' }));
    await guard(ctl, av.play('lookAround'));
    await guard(ctl, av.pose('idle', { duration: 480 }));
    await guard(ctl, av.walkTo(stand, { speed: walkSpeed(Math.abs(stand - peekX), 1.8) }));
    av.setFacing(0);
    return;
  }

  await guard(ctl, av.walkTo(stand, { speed: walkSpeed(Math.abs(stand - offX), 2.1) }));
}

// ------------------------------------------------------------------------------------------------ waiting
function countdown(ctl, seconds) {
  if (!(seconds > 0) || ctl.outcome || ctl.aborted) return;
  const total = seconds * 1000;
  let elapsed = 0;
  let last = performance.now();
  const tick = () => {
    if (ctl.outcome || ctl.aborted) return;
    const now = performance.now();
    if (!interactive) elapsed += now - last; // the clock pauses while the user points at the buddy or bubble
    last = now;
    const f = elapsed / total;
    bubble.setCountdown(f);
    if (f >= 1) ctl.answer('timeout');
    else ctl.later(tick, 200);
  };
  tick();
}

// Occasional micro-acts while waiting for an answer (yawns late at night).
function scheduleIdle(ctl, night) {
  const beat = () => {
    if (ctl.phase !== 'ask' || ctl.outcome) return;
    if (!av.busy && performance.now() > pet.cooldown) {
      const roll = Math.random();
      if (night && roll < 0.5) av.play('yawn');
      else if (roll < 0.65) av.play('lookAround');
      else {
        av.pose('think', { duration: 420 });
        ctl.later(() => ctl.phase === 'ask' && !ctl.outcome && av.pose('present', { duration: 420 }), 1600);
      }
    }
    ctl.later(beat, rand(7000, 11000));
  };
  ctl.later(beat, rand(6000, 9000));
}

// ------------------------------------------------------------------------------------------------ reactions
async function readFor(ctl, text, since) {
  await guard(ctl, sleep(Math.max(0, readMs(text) - (performance.now() - since))));
}

async function reactYes(ctl, r, vars, say, welcome) {
  const total = Number(vars.goal) || 0;
  const goal = !welcome && total > 0
    ? { count: (Number(vars.count) || 0) + 1, total, shape: ['bottle', 'glass', 'mug'].includes(r.prop) ? 'drop' : 'dot' }
    : null;
  const reached = !!goal && goal.count === goal.total;
  const text = say('yesReply');
  const since = performance.now();
  av.setMood('happy');
  sfx.play('happy');
  const replied = bubble.reply(text, { mood: 'happy', goal });
  replied.then(() => {
    if (!reached || ctl.aborted) return;
    av.fx('confetti');
    sfx.play('sparkle');
  });
  const action = r.action || 'cheer';
  await guard(ctl, av.play(action));
  av.fx('hearts');
  av.fx('sparkles');
  if (action !== 'cheer') await guard(ctl, av.play('cheer'));
  await guard(ctl, replied);
  await readFor(ctl, text, since);
  await hideBubble(ctl);
  await exit(ctl, 'happy');
}

async function reactLater(ctl, say, vars) {
  const streak = Math.max(0, Number(vars.laterStreak) || 0);
  const text = say('laterReply');
  const since = performance.now();
  av.setMood('sad');
  av.pose('sad', { duration: 650 });
  sfx.play('sad');
  await guard(ctl, bubble.reply(text, { mood: 'sad' }));
  await readFor(ctl, text, since);
  await hideBubble(ctl);
  if (streak >= 1) {
    av.fx(streak >= 2 ? 'storm' : 'raincloud', { duration: Infinity });
    await guard(ctl, sleep(560));
    await guard(ctl, av.play('sigh'));
  }
  await exit(ctl, 'sad');
}

async function reactTimeout(ctl, say, welcome) {
  if (welcome) {
    // the welcome's "later" text describes opening settings, which a timeout doesn't do: wave goodbye silently
    await Promise.all([hideBubble(ctl), guard(ctl, av.play('wave'))]);
    await exit(ctl, 'happy');
    return;
  }
  const text = say('laterReply');
  const since = performance.now();
  av.pose('shrug', { duration: 380 });
  await guard(ctl, bubble.reply(text, { mood: 'neutral' }));
  await readFor(ctl, text, since);
  await hideBubble(ctl);
  await exit(ctl, 'neutral');
}

async function reactCustomize(ctl, say) {
  nudge.openSettings();
  const text = say('laterReply');
  const since = performance.now();
  av.setMood('happy');
  bubble.reply(text, { mood: 'happy' });
  await guard(ctl, av.play('wave'));
  await readFor(ctl, text, since);
  await hideBubble(ctl);
  await exit(ctl, 'happy');
}

async function reactDismiss(ctl) {
  await Promise.all([hideBubble(ctl), guard(ctl, av.play('wave'))]);
  await exit(ctl, 'neutral');
}

async function exit(ctl, mood) {
  setPhase(ctl, 'exit');
  av.pose(mood === 'sad' ? 'sad' : 'idle', { duration: 320 });
  const W = stage.clientWidth;
  const w = av.width;
  const toLeft = av.x + w / 2 < W / 2;
  const target = toLeft ? -w * 1.35 : W + w * 0.35;
  const secs = mood === 'sad' ? 4.2 : 2.4;
  await guard(ctl, av.walkTo(target, { mood, speed: walkSpeed(Math.abs(target - av.x), secs, mood) }));
}

// ------------------------------------------------------------------------------------------------ pointer
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  nudge.setInteractive(on);
}

function overAvatar() {
  return !!(av && current && current.phase === 'ask' && pointer.inside && av.hitTest(pointer.x, pointer.y));
}

function updateHit() {
  if (!current || current.phase === 'exit' || !pointer.inside) return setInteractive(false);
  const el = document.elementFromPoint(pointer.x, pointer.y);
  setInteractive(bubble.isInteractiveTarget(el) || overAvatar());
}

// Petting = the cursor keeps moving over the buddy for ~600 ms.
function checkPetting() {
  const now = performance.now();
  if (!overAvatar() || current.outcome) {
    pet.since = 0;
    return;
  }
  if (!pet.since || now - pet.last > 300) pet.since = now;
  pet.last = now;
  if (now - pet.since < 600 || now < pet.cooldown) return;
  pet.cooldown = now + 4000;
  pet.since = 0;
  av.play('pet');
  av.fx('hearts', { count: 4 });
  sfx.play('giggle', { pan: pan() });
}

// Mouse events (not pointer events): these are what Electron forwards while the window is click-through.
addEventListener('mousemove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.inside = true;
  if (!current) return;
  av.lookAt(e.clientX, e.clientY);
  updateHit();
  checkPetting();
}, { passive: true });

document.documentElement.addEventListener('mouseleave', () => {
  pointer.inside = false;
  if (av) av.lookAt(null);
  pet.since = 0;
  updateHit();
});

addEventListener('mousedown', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.inside = true;
  const now = performance.now();
  if (!overAvatar() || current.outcome || now < pokeCooldown) return;
  pokeCooldown = now + 700;
  pet.cooldown = Math.max(pet.cooldown, now + 1500);
  av.play('poke');
  sfx.play('giggle', { pan: pan() });
});

// The work area changed under a waiting buddy (display switch / DPI change): re-stand and re-anchor the bubble.
addEventListener('resize', () => {
  if (!current || !av || (current.phase !== 'ask' && current.phase !== 'arrive')) return;
  av.x = standX(current.run.settings.side);
  placeBubble();
});

// ------------------------------------------------------------------------------------------------ dev backdrop
// Browser previews only (never inside Electron, where the page must stay fully transparent).
function buildDevDesk() {
  document.documentElement.classList.add('nb-dev');
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const desk = el('div', 'devdesk');
  desk.setAttribute('aria-hidden', 'true');

  const title = el('div', 'devdesk-title');
  title.append(el('i', 'devdesk-dot'), el('i', 'devdesk-dot'), el('i', 'devdesk-dot'), el('span', '', 'scheduler.js - nudgi'));

  const tree = el('div', 'devdesk-tree');
  [['src', 0], ['main', 1], ['main.js', 2], ['scheduler.js', 2, true], ['store.js', 2], ['renderer', 1], ['package.json', 0]]
    .forEach(([name, depth, open]) => {
      const row = el('div', open ? 'is-open' : '', name);
      row.style.paddingLeft = `${16 + depth * 12}px`;
      tree.append(row);
    });

  const CODE = [
    [['tk-c', '// Next moment a reminder should fire, inside its active window.']],
    [['tk-k', 'export function '], ['tk-f', 'nextFire'], ['', '(reminder, now) {']],
    [['tk-k', '  if '], ['', '(!reminder.enabled) '], ['tk-k', 'return '], ['tk-n', 'null'], ['', ';']],
    [['tk-k', '  const '], ['tk-v', 'every'], ['', ' = reminder.schedule.every * '], ['tk-n', '60000'], ['', ';']],
    [['tk-k', '  let '], ['tk-v', 't'], ['', ' = Math.'], ['tk-f', 'max'], ['', '('], ['tk-f', 'windowStart'], ['', '(reminder, now), now + every);']],
    [['tk-k', '  while '], ['', '(!'], ['tk-f', 'inWindow'], ['', '(reminder.schedule, t)) t = '], ['tk-f', 'nextWindow'], ['', '(reminder, t);']],
    [['tk-k', '  return '], ['', 't;']],
    [['', '}']],
    [],
    [['tk-k', 'export const '], ['tk-v', 'SNOOZE_MIN'], ['', ' = '], ['tk-n', '15'], ['', ';']],
    [['tk-k', 'export const '], ['tk-v', 'DAY_KEY'], ['', ' = (d) => d.'], ['tk-f', 'toLocaleDateString'], ['', '('], ['tk-s', "'sv-SE'"], ['', ');']],
    [],
  ];
  const code = el('div', 'devdesk-code');
  for (let i = 0; i < 60; i++) {
    const row = el('div');
    row.append(el('i', '', String(i + 1)));
    for (const [cls, text] of CODE[i % CODE.length]) row.append(el('span', cls, text));
    code.append(row);
  }

  const status = el('div', 'devdesk-status', 'main   Ln 7, Col 12   Spaces: 2   UTF-8   JavaScript');
  desk.append(title, el('div', 'devdesk-bar'), tree, code, status);
  document.body.prepend(desk);
}

if (location.protocol !== 'file:') buildDevDesk();
nudge.overlayReady();
