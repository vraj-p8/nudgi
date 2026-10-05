import '../shared/mock-api.js';
import {
  createAvatar, AVATARS, PROPS, ACTIONS, MOVES, FX, POSE_NAMES, EXPRESSION_NAMES,
} from '../shared/avatar-engine.js';

// A sample picture for the custom-image avatar (a cheerful potted cactus).
const SAMPLE_IMAGE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 240">
<defs><linearGradient id="c" x1="0" x2="1"><stop offset="0" stop-color="#3FA35F"/><stop offset=".45" stop-color="#6FD08B"/><stop offset="1" stop-color="#3E9C5B"/></linearGradient>
<linearGradient id="p" x1="0" x2="1"><stop offset="0" stop-color="#C9623C"/><stop offset=".4" stop-color="#F2946A"/><stop offset="1" stop-color="#C25A35"/></linearGradient></defs>
<path d="M44 176h72l-7 56a8 8 0 0 1-8 7H59a8 8 0 0 1-8-7z" fill="url(#p)"/><rect x="36" y="164" width="88" height="20" rx="9" fill="#F49E76"/>
<rect x="38" y="167" width="84" height="5" rx="2.5" fill="#fff" opacity=".35"/>
<path d="M54 120h-12a12 12 0 0 1-12-12V86a8 8 0 0 1 16 0v18h8z" fill="url(#c)"/><path d="M106 104h12V74a8 8 0 0 1 16 0v30a12 12 0 0 1-12 12h-16z" fill="url(#c)"/>
<rect x="52" y="44" width="56" height="126" rx="28" fill="url(#c)"/><rect x="60" y="54" width="7" height="90" rx="3.5" fill="#fff" opacity=".22"/>
<g fill="#2E7A46" opacity=".55"><circle cx="62" cy="70" r="1.6"/><circle cx="98" cy="64" r="1.6"/><circle cx="94" cy="132" r="1.6"/><circle cx="64" cy="150" r="1.6"/><circle cx="38" cy="96" r="1.4"/><circle cx="124" cy="84" r="1.4"/></g>
<ellipse cx="70" cy="98" rx="5" ry="6" fill="#20160F"/><ellipse cx="90" cy="98" rx="5" ry="6" fill="#20160F"/><circle cx="71.6" cy="95.6" r="1.8" fill="#fff"/><circle cx="91.6" cy="95.6" r="1.8" fill="#fff"/>
<path d="M73 110q7 6 14 0" fill="none" stroke="#20160F" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="62" cy="108" rx="6" ry="3.5" fill="#FF8FA3" opacity=".6"/><ellipse cx="98" cy="108" rx="6" ry="3.5" fill="#FF8FA3" opacity=".6"/>
<g transform="translate(80 40)"><circle cx="-8" cy="-4" r="7" fill="#FF7AA8"/><circle cx="8" cy="-4" r="7" fill="#FF7AA8"/><circle cx="0" cy="-12" r="7" fill="#FF97BC"/><circle cx="0" cy="3" r="7" fill="#FF97BC"/><circle cx="0" cy="-4" r="4.5" fill="#FFD54A"/></g>
</svg>`)}`;

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const labels = $('#labels');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { height: 250, slow: false, freeze: false, rig: false, follow: true, last: null };
const buddies = AVATARS.map((info) => ({ info, on: true, av: null, homeX: 0, label: null }));

function stageHeight() {
  return Math.round(state.height + Math.max(150, state.height * 0.62));
}

function timeScale() {
  return state.freeze ? 0 : state.slow ? 0.25 : 1;
}

function build() {
  stage.style.height = `${stageHeight()}px`;
  for (const b of buddies) {
    b.av = createAvatar(stage, {
      avatarId: b.info.id,
      customUrl: b.info.id === 'custom' ? SAMPLE_IMAGE : null,
      height: state.height,
      prop: b.info.id === 'custom' ? 'glass' : 'bottle',
    });
    b.av.on('step', (e) => logEvent(b, `step ${e.foot}`));
    b.av.on('land', () => logEvent(b, 'land'));
    b.av.on('hop', () => logEvent(b, 'hop'));
    b.av.on('gulp', (i) => logEvent(b, `gulp ${i + 1}`));
    b.av.on('flash', () => logEvent(b, 'flash'));
    const label = document.createElement('label');
    label.className = 'label';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => (b.on = box.checked));
    const name = document.createElement('b');
    name.textContent = b.info.name;
    const meta = document.createElement('span');
    meta.textContent = `${b.info.id} · ${b.info.locomotion} · ${b.info.tagline}`;
    label.append(box, name, meta);
    labels.appendChild(label);
    b.label = label;
  }
  layout();
}

function layout() {
  const n = buddies.length;
  const w = buddies[0].av.width;
  const minW = n * (w + 48) + 48;
  stage.style.minWidth = `${minW}px`;
  stage.style.height = `${stageHeight()}px`;
  labels.style.minWidth = `${minW}px`;
  const W = Math.max(stage.clientWidth, minW);
  buddies.forEach((b, i) => {
    const cx = (W / n) * (i + 0.5);
    b.homeX = Math.round(cx - b.av.width / 2);
    b.av.x = b.homeX;
    b.label.style.left = `${cx}px`;
  });
}

const selected = () => buddies.filter((b) => b.on);

function run(label, fn) {
  state.last = { label, fn };
  $('#status').textContent = `▶ ${label}`;
  for (const b of selected()) Promise.resolve(fn(b.av, b)).catch((e) => console.error(e));
}

function logEvent(b, text) {
  if (b !== (selected()[0] || null)) return;
  const box = $('#events');
  const ev = document.createElement('span');
  ev.className = 'ev';
  ev.textContent = text;
  box.prepend(ev);
  while (box.children.length > 14) box.lastChild.remove();
}

function buttons(container, items, onClick, hot = []) {
  const el = $(container);
  for (const it of items) {
    const btn = document.createElement('button');
    btn.textContent = it.name;
    if (hot.includes(it.id)) btn.classList.add('is-hot');
    btn.addEventListener('click', () => onClick(it));
    el.appendChild(btn);
  }
}

const title = (s) => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

// ------------------------------------------------------------------------------------------- scenes
async function sceneYes(av, b) {
  const W = stage.clientWidth;
  av.stop();
  av.setMood('neutral');
  av.fx('clear');
  av.pose('idle', { duration: 200 });
  av.x = -av.width - 24;
  await av.walkTo(b.homeX);
  await av.pose('present');
  av.say(1400);
  await wait(1500 / Math.max(0.25, timeScale() || 1));
  await av.play('drink');
  av.setMood('happy');
  av.fx('hearts');
  av.fx('sparkles');
  await av.play('cheer');
  av.pose('idle');
  await av.walkTo(W + 24);
  av.setMood('neutral');
  av.x = -av.width - 24;
  await av.walkTo(b.homeX);
}

async function sceneLater(av, b) {
  const W = stage.clientWidth;
  av.stop();
  av.fx('clear');
  av.setMood('neutral');
  await av.pose('present', { duration: 300 });
  av.setMood('sad');
  await av.pose('sad');
  const cloud = av.fx('storm', { duration: Infinity });
  await av.play('sigh');
  await av.walkTo(W + 24, { mood: 'sad' });
  cloud.stop();
  av.setMood('neutral');
  av.pose('idle', { duration: 200 });
  av.x = -av.width - 24;
  await av.walkTo(b.homeX);
}

async function sceneDrop(av, b) {
  av.stop();
  av.fx('clear');
  av.setMood('happy');
  av.x = b.homeX;
  av.y = stageHeight();
  av.pose('umbrella', { duration: 10 });
  await av.glideTo({ y: 0 }, { ms: 2200, ease: 'out', sway: 9 });
  av.pose('idle', { duration: 300 });
  av.fx('dust');
  await av.play('land');
  av.setMood('neutral');
}

async function scenePeek(av, b) {
  const W = stage.clientWidth;
  av.stop();
  av.fx('clear');
  av.setMood('neutral');
  av.x = W - av.width * 0.45;
  av.setFacing(-1);
  await av.pose('peek', { duration: 300 });
  await av.play('lookAround');
  av.pose('idle');
  await av.play('jump');
  await av.walkTo(b.homeX);
}

async function sceneWalk(av, b) {
  const W = stage.clientWidth;
  const d = Math.min(W * 0.32, 360);
  await av.walkTo(b.homeX + d);
  await av.walkTo(b.homeX);
}

// ------------------------------------------------------------------------------------------- controls
function setupControls() {
  buttons('#scenes', [
    { id: 'yes', name: 'YES · drink & cheer' }, { id: 'later', name: 'Later · storm & sad walk' },
    { id: 'drop', name: 'Drop entrance' }, { id: 'peek', name: 'Peek entrance' },
  ], (it) => run(`scene ${it.id}`, { yes: sceneYes, later: sceneLater, drop: sceneDrop, peek: scenePeek }[it.id]));
  $('#scenes').firstChild.classList.add('primary');

  buttons('#poses', POSE_NAMES.map((id) => ({ id, name: title(id) })), (it) => run(`pose ${it.id}`, (av) => av.pose(it.id)));
  buttons('#expressions', EXPRESSION_NAMES.map((id) => ({ id, name: title(id) })), (it) => run(`expression ${it.id}`, (av) => av.expression(it.id)));
  buttons('#actions', ACTIONS, (it) => run(`play ${it.id}`, (av) => av.play(it.id)));
  buttons('#moves', MOVES.filter((m) => !ACTIONS.some((a) => a.id === m.id)), (it) => run(`play ${it.id}`, (av) => av.play(it.id)));
  buttons('#fx', [...FX.map((id) => ({ id, name: title(id) })), { id: 'clear', name: 'Clear' }], (it) => run(`fx ${it.id}`, (av) => av.fx(it.id)), ['clear']);
  buttons('#props', PROPS, (it) => run(`prop ${it.id}`, (av) => av.setProp(it.id, $('#emoji').value)));
  buttons('#facing', [{ id: -1, name: '← Face left' }, { id: 0, name: 'Front' }, { id: 1, name: 'Face right →' }], (it) => run(`facing ${it.id}`, (av) => av.setFacing(it.id)));

  const walks = $('#walks');
  for (const [name, fn] of [['Walk across & back', sceneWalk], ['Sad walk', (av, b) => av.walkTo(b.homeX + 200, { mood: 'sad' }).then(() => av.walkTo(b.homeX, { mood: 'sad' }))], ['Stop', (av) => av.stop()]]) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.addEventListener('click', () => run(name, fn));
    walks.appendChild(btn);
  }
  const moods = $('#moods');
  for (const m of ['neutral', 'happy', 'sad']) {
    const btn = document.createElement('button');
    btn.textContent = `Mood: ${m}`;
    btn.addEventListener('click', () => run(`mood ${m}`, (av) => av.setMood(m)));
    moods.appendChild(btn);
  }

  const sw = $('#swatches');
  for (const c of ['#2BB3A3', '#FF7A59', '#7C5CFF', '#FFC53D', '#EF476F', '#3A86FF', '#22C55E', '#1F2937']) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => run(`color ${c}`, (av) => av.setColor(c)));
    sw.appendChild(b);
  }
  $('#color').addEventListener('input', (e) => run(`color ${e.target.value}`, (av) => av.setColor(e.target.value)));
  $('#color-reset').addEventListener('click', () => run('color default', (av) => av.setColor(null)));
  $('#say').addEventListener('click', () => run('say', (av) => av.say(1600)));
  $('#blink').addEventListener('click', () => run('blink', (av) => av.play('lookAround')));

  // view
  $('#bg-seg').addEventListener('click', (e) => {
    const bg = e.target.dataset.bg;
    if (!bg) return;
    stage.className = `stage bg-${bg}`;
    for (const b of $('#bg-seg').children) b.setAttribute('aria-pressed', String(b.dataset.bg === bg));
  });
  const setHeight = (h) => {
    state.height = h;
    $('#scale').value = h;
    $('#scale-val').textContent = `${h} px`;
    for (const b of $('#size-seg').children) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === h));
    for (const b of buddies) b.av.setHeight(h);
    layout();
  };
  $('#scale').addEventListener('input', (e) => setHeight(Number(e.target.value)));
  $('#size-seg').addEventListener('click', (e) => e.target.dataset.size && setHeight(Number(e.target.dataset.size)));
  const toggle = (id, key, after) => {
    const btn = $(id);
    const flip = () => {
      state[key] = !state[key];
      btn.setAttribute('aria-pressed', String(state[key]));
      after();
    };
    btn.addEventListener('click', flip);
    return flip;
  };
  const applyTime = () => {
    for (const b of buddies) b.av.timeScale = timeScale();
    for (const s of stressSet) s.timeScale = timeScale();
  };
  const flipSlow = toggle('#slow', 'slow', applyTime);
  const flipFreeze = toggle('#freeze', 'freeze', applyTime);
  const flipRig = toggle('#rig', 'rig', () => buddies.forEach((b) => b.av.debug(state.rig)));
  toggle('#follow', 'follow', () => !state.follow && buddies.forEach((b) => b.av.lookAt(null)));

  addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 's' || e.key === 'S') flipSlow();
    else if (e.key === 'f' || e.key === 'F') flipFreeze();
    else if (e.key === 'r' || e.key === 'R') flipRig();
    else if (e.key === ' ' && state.last) {
      e.preventDefault();
      run(state.last.label, state.last.fn);
    }
  });

  addEventListener('mousemove', (e) => {
    if (!state.follow) return;
    for (const b of buddies) b.av.lookAt(e.clientX, e.clientY);
  });
  stage.addEventListener('click', (e) => {
    const hit = buddies.find((b) => b.av.hitTest(e.clientX, e.clientY));
    if (hit) hit.av.play('poke');
  });
  addEventListener('resize', layout);

  $('#stress-open').addEventListener('click', openStress);
  $('#stress-close').addEventListener('click', closeStress);
}

// ------------------------------------------------------------------------------------------- stress
const stressSet = new Set();
let stressTimer = 0;
function openStress() {
  $('#stress').classList.add('is-open');
  const host = $('#stress-stage');
  const W = host.clientWidth;
  const ids = AVATARS.map((a) => a.id);
  const colors = [null, '#FF7A59', '#7C5CFF', '#EF476F', '#3A86FF', '#22C55E'];
  const props = PROPS.map((p) => p.id);
  for (let i = 0; i < 6; i++) {
    const id = ids[i % ids.length];
    const av = createAvatar(host, {
      avatarId: id, customUrl: id === 'custom' ? SAMPLE_IMAGE : null, height: 200,
      color: colors[i], prop: props[(i * 3) % props.length], emoji: '🌟', timeScale: timeScale(),
    });
    av.x = Math.round((W / 6) * (i + 0.5) - av.width / 2);
    av.debug(state.rig);
    stressSet.add(av);
  }
  const moves = [...MOVES.map((m) => m.id), 'walk'];
  const fxs = ['hearts', 'sparkles', 'confetti', 'raincloud', 'zzz', 'notes', 'dust'];
  const step = () => {
    for (const av of stressSet) {
      if (av.busy || Math.random() < 0.3) continue;
      const m = moves[Math.floor(Math.random() * moves.length)];
      if (m === 'walk') av.walkTo(Math.max(0, Math.min(W - av.width, av.x + (Math.random() - 0.5) * 220)));
      else av.play(m);
      if (Math.random() < 0.35) av.fx(fxs[Math.floor(Math.random() * fxs.length)]);
    }
  };
  step();
  stressTimer = setInterval(step, 1800);
}
function closeStress() {
  clearInterval(stressTimer);
  for (const av of stressSet) av.destroy();
  stressSet.clear();
  $('#stress').classList.remove('is-open');
}

// ------------------------------------------------------------------------------------------- meters
function meters() {
  let frames = 0;
  let t0 = performance.now();
  const loop = (t) => {
    frames++;
    if (t - t0 >= 500) {
      const fps = Math.round((frames * 1000) / (t - t0));
      $('#fps').textContent = `${fps} fps`;
      $('#stress-fps').textContent = `${fps} fps`;
      frames = 0;
      t0 = t;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  let errors = 0;
  const bump = () => {
    errors++;
    const el = $('#errors');
    el.textContent = `${errors} error${errors === 1 ? '' : 's'}`;
    el.classList.add('is-bad');
  };
  addEventListener('error', bump);
  addEventListener('unhandledrejection', bump);
}

// ------------------------------------------------------------------------------------------- loupe
// gallery.html?solo=<avatarId>&h=<px>&focus=head|body|feet|full&bg=<css colour>&prop=<id>
// Renders one buddy very large in a fixed overlay for pixel-level art checks (window.__solo is the avatar).
function loupe(params) {
  const id = params.get('solo');
  const ov = document.createElement('div');
  Object.assign(ov.style, { position: 'fixed', inset: '0', zIndex: '100', overflow: 'hidden', background: params.get('bg') || '#f4f6fa' });
  document.body.appendChild(ov);
  const vh = ov.clientHeight;
  const focus = params.get('focus') || 'head';
  const h = Number(params.get('h')) || (focus === 'full' ? vh - 40 : vh * 2);
  // The host's floor is placed so the focused band of the 300-unit rig fills the viewport.
  const band = { head: [0, 160], body: [140, 260], feet: [230, 306], full: [0, 306] }[focus] || [0, 160];
  const k = h / 300;
  const floor = vh + (300 - band[1]) * k - Math.max(0, (vh - (band[1] - band[0]) * k) / 2);
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'absolute', left: '0', right: '0', top: '0', height: `${Math.round(floor)}px` });
  ov.appendChild(host);
  const av = createAvatar(host, {
    avatarId: id, customUrl: id === 'custom' ? SAMPLE_IMAGE : null, height: h, prop: params.get('prop') || 'bottle',
  });
  av.x = Math.round((ov.clientWidth - av.width) / 2);
  window.__solo = av;
}

const params = new URLSearchParams(location.search);
meters();
build();
setupControls();
if (params.get('solo')) loupe(params);
window.__lab = { buddies, state, stage };
