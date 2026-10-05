// Particle / overlay effects around an avatar (hearts, sparkles, rain cloud, confetti, ...).
// Pure DOM + Web Animations API (compositor-friendly transforms/opacity). Styles live in fx.css.
//
// Called by the engine as playFx(ctx, name, opts) where ctx provides:
//   world / local      layers: `world` sits in the host (particles stay where they were emitted),
//                      `local` is inside the avatar element (followers such as the rain cloud move with the buddy)
//   anchorWorld(n) / anchorLocal(n)   -> {x, y} px of a named anchor in that layer
//   width, height, k   avatar box in px and size factor (k = height / 250)
//   track(anim)        registers a WAAPI animation so slow-motion (timeScale) applies to it
//   after(ms, fn)      timer on the avatar clock (honours timeScale), returns a cancel function
//   setBlush(v, ms)    drives the avatar's own blush part
//   emit(name, data)   avatar event (e.g. 'flash' for storm lightning)
// Every effect returns a handle { stop(), done } and removes its nodes when finished.

export const FX = ['hearts', 'sparkles', 'raincloud', 'storm', 'confetti', 'dust', 'sweat', 'zzz', 'blush',
  'exclaim', 'question', 'notes', 'puff', 'bubbles'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function node(cls, html, x, y) {
  const el = document.createElement('div');
  el.className = `nb-fx ${cls}`;
  if (html) el.innerHTML = html;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  return el;
}

// One-shot animated node: appended, animated, removed when done.
function shot(ctx, layer, el, frames, timing) {
  layer.appendChild(el);
  const anim = ctx.track(el.animate(frames, { fill: 'both', ...timing }));
  const done = anim.finished.then(() => el.remove(), () => el.remove());
  return { anim, done };
}

function group(parts) {
  const done = Promise.all(parts.map((p) => p.done)).then(() => undefined);
  return { done, stop: () => parts.forEach((p) => p.anim && p.anim.finish()) };
}

const C = 'translate(-50%,-50%)';

// Unique gradient ids: particles coexist in one document, and url(#id) must never point at a removed node.
let gid = 0;
const uid = () => `nbfx${++gid}`;

// ---------------------------------------------------------------------------------------------- shapes

const heartSvg = (s, hue, id = uid()) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${hue[0]}"/><stop offset="1" stop-color="${hue[1]}"/></linearGradient></defs>` +
  `<path d="M12 21.2C5.4 16.6 2 13 2 8.6 2 5.5 4.4 3.2 7.3 3.2c1.9 0 3.6 1 4.7 2.6 1.1-1.6 2.8-2.6 4.7-2.6 2.9 0 5.3 2.3 5.3 5.4 0 4.4-3.4 8-10 12.6z" fill="${hue[1]}"/>` +
  `<path d="M12 20.2C5.9 15.9 3 12.6 3 8.7 3 6.1 5 4.2 7.4 4.2c1.8 0 3.4 1.1 4.6 2.9 1.2-1.8 2.8-2.9 4.6-2.9 2.4 0 4.4 1.9 4.4 4.5 0 3.9-2.9 7.2-9 11.5z" fill="url(#${id})"/>` +
  `<ellipse cx="7.6" cy="8" rx="2.2" ry="1.5" fill="#fff" opacity=".75" transform="rotate(-30 7.6 8)"/></svg>`;

const sparkleSvg = (s, color) =>
  `<svg width="${s}" height="${s}" viewBox="-12 -12 24 24"><path d="M0 -11 C1.2 -3.4 3.4 -1.2 11 0 C3.4 1.2 1.2 3.4 0 11 C-1.2 3.4 -3.4 1.2 -11 0 C-3.4 -1.2 -1.2 -3.4 0 -11Z" fill="${color}"/>` +
  `<circle r="2.2" fill="#fff" opacity=".9"/></svg>`;

const cloudSvg = (w, storm, id = uid()) => {
  const top = storm ? '#8792A6' : '#E4E9F1';
  const bot = storm ? '#4F5869' : '#AEB8C8';
  const face = storm ? '#2E3442' : '#7C889C';
  return `<svg width="${w}" height="${w * 0.56}" viewBox="0 0 120 67"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient></defs>` +
    `<ellipse cx="60" cy="61" rx="44" ry="4" fill="#000" opacity=".08"/>` +
    `<path d="M24 56 C10 56 6 42 16 36 C14 24 28 16 38 22 C42 8 64 4 72 18 C80 10 98 14 98 28 C110 28 114 42 106 50 C104 54 100 56 96 56 Z" fill="url(#${id})"/>` +
    `<path d="M30 30 C33 22 41 21 45 25 M70 20 C74 15 82 15 85 20" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="${storm ? 0.22 : 0.7}"/>` +
    `<path d="M48 40 q3 2.6 6 0 M66 40 q3 2.6 6 0" fill="none" stroke="${face}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<path d="M56 48 q4 -2.4 8 0" fill="none" stroke="${face}" stroke-width="2" stroke-linecap="round"/></svg>`;
};

const boltSvg = (s) =>
  `<svg width="${s * 0.6}" height="${s}" viewBox="0 0 30 50"><path d="M18 1 L4 28 H14 L9 49 L27 18 H16 L22 1 Z" fill="#FFE45C" stroke="#FFF7C2" stroke-width="2" stroke-linejoin="round"/></svg>`;

const dropSvg = (s, a = '#9EDBFF', b = '#3FA9F5', id = uid()) =>
  `<svg width="${s}" height="${s * 1.35}" viewBox="0 0 20 27"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
  `<path d="M10 1 C10 1 18 11.5 18 17.4 A8 8 0 0 1 2 17.4 C2 11.5 10 1 10 1 Z" fill="url(#${id})"/>` +
  `<ellipse cx="6.8" cy="17" rx="1.8" ry="3" fill="#fff" opacity=".7"/></svg>`;

const textSvg = (s, ch, fill, stroke) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 40 40"><text x="20" y="21" text-anchor="middle" dominant-baseline="central" ` +
  `font-family="Fredoka, 'Segoe UI', sans-serif" font-weight="700" font-size="34" fill="${fill}" stroke="${stroke}" ` +
  `stroke-width="5" stroke-linejoin="round" paint-order="stroke">${ch}</text></svg>`;

const noteSvg = (s, color) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M9 4.5 L19 2.5 V15.2 A3.4 2.8 -18 1 1 16.6 12.8 V7.4 L11.4 8.5 V17.7 A3.4 2.8 -18 1 1 9 15.3 Z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke"/></svg>`;

const puffSvg = (s) =>
  `<svg width="${s}" height="${s * 0.7}" viewBox="0 0 40 28"><g fill="#F3F6FA" opacity=".9"><circle cx="12" cy="16" r="8"/><circle cx="22" cy="11" r="9"/><circle cx="30" cy="17" r="7"/></g>` +
  `<g fill="#C9D3E0" opacity=".55"><circle cx="14" cy="19" r="5"/><circle cx="28" cy="20" r="4"/></g></svg>`;

const bubbleSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="#BFEAFF" fill-opacity=".25" stroke="#8FD6FF" stroke-width="1.4"/>` +
  `<ellipse cx="7" cy="6.6" rx="2.6" ry="1.6" fill="#fff" opacity=".85" transform="rotate(-35 7 6.6)"/></svg>`;

const CONFETTI = ['var(--nb-primary, #2BB3A3)', '#FFC53D', '#FF7A59', '#38D3EE', '#A78BFA', '#22C55E', '#FF5C8A'];

// ---------------------------------------------------------------------------------------------- effects

const EFFECTS = {
  hearts(ctx, o) {
    const a = ctx.anchorWorld(o.anchor || 'top');
    const n = o.count ?? 6;
    const hues = [['#FF8FB3', '#FF3D7F'], ['#FFA2C0', '#FF5C93'], ['#FF7AA8', '#F0306E']];
    const parts = [];
    for (let i = 0; i < n; i++) {
      const s = rand(15, 25) * ctx.k;
      const x = a.x + rand(-0.32, 0.32) * ctx.width;
      const y = a.y + rand(0.05, 0.3) * ctx.height;
      const dx = rand(-26, 26) * ctx.k;
      const rise = rand(70, 130) * ctx.k;
      const r = rand(-18, 18);
      parts.push(shot(ctx, ctx.world, node('nb-fx-heart', heartSvg(s, pick(hues)), x, y), [
        { transform: `${C} translate(0,0) scale(.2) rotate(${r}deg)`, opacity: 0 },
        { transform: `${C} translate(${dx * 0.3}px,${-rise * 0.22}px) scale(1.08) rotate(${-r * 0.5}deg)`, opacity: 1, offset: 0.22 },
        { transform: `${C} translate(${-dx * 0.35}px,${-rise * 0.62}px) scale(1) rotate(${r * 0.6}deg)`, opacity: 0.95, offset: 0.62 },
        { transform: `${C} translate(${dx}px,${-rise}px) scale(.86) rotate(0deg)`, opacity: 0 },
      ], { duration: rand(1500, 2100), delay: i * 120 + rand(0, 60), easing: 'cubic-bezier(.22,.7,.34,1)' }));
    }
    return group(parts);
  },

  sparkles(ctx, o) {
    const a = ctx.anchorWorld(o.anchor || 'chest');
    const n = o.count ?? 8;
    const spread = o.spread ?? 1;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rand(-0.4, 0.4);
      const rx = ctx.width * rand(0.34, 0.56) * spread;
      const ry = ctx.height * rand(0.26, 0.44) * spread;
      const x = a.x + Math.cos(ang) * rx;
      const y = a.y + Math.sin(ang) * ry * 0.9 - ctx.height * 0.08;
      const s = rand(12, 22) * ctx.k;
      const spin = rand(60, 140) * (Math.random() < 0.5 ? -1 : 1);
      parts.push(shot(ctx, ctx.world, node('nb-fx-sparkle', sparkleSvg(s, pick(['#FFD54A', '#FFE680', '#FFFFFF', '#FFC23D'])), x, y), [
        { transform: `${C} scale(0) rotate(0deg)`, opacity: 0 },
        { transform: `${C} scale(1.15) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.4 },
        { transform: `${C} scale(0) rotate(${spin}deg)`, opacity: 0 },
      ], { duration: rand(620, 900), delay: rand(0, 700), easing: 'cubic-bezier(.3,.8,.4,1)' }));
    }
    return group(parts);
  },

  raincloud(ctx, o) {
    return cloud(ctx, o, false);
  },

  storm(ctx, o) {
    return cloud(ctx, o, true);
  },

  confetti(ctx, o) {
    const a = o.at || ctx.anchorWorld(o.anchor || 'top');
    const n = o.count ?? 42;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ang = (-90 + rand(-62, 62)) * (Math.PI / 180);
      const sp = rand(280, 560) * ctx.k;
      const vx = Math.cos(ang) * sp;
      const vy = Math.sin(ang) * sp;
      const g = 900 * ctx.k;
      const T = rand(1.7, 2.5);
      const spin = rand(-720, 720);
      const flip = rand(6, 14);
      const frames = [];
      const steps = 16;
      for (let s = 0; s <= steps; s++) {
        const t = (s / steps) * T;
        const drag = (1 - Math.exp(-1.6 * t)) / 1.6; // horizontal air drag
        const x = vx * drag;
        const y = vy * drag + 0.5 * g * t * t * 0.55;
        frames.push({
          transform: `${C} translate(${x}px,${y}px) rotate(${spin * t}deg) scaleY(${Math.cos(t * flip).toFixed(3)})`,
          opacity: s / steps > 0.78 ? 1 - (s / steps - 0.78) / 0.22 : 1,
        });
      }
      const round = Math.random() < 0.3;
      const el = node('nb-fx-confetti', '', a.x, a.y);
      el.style.width = `${(round ? 7 : rand(6, 9)) * ctx.k}px`;
      el.style.height = `${(round ? 7 : rand(10, 14)) * ctx.k}px`;
      el.style.borderRadius = round ? '50%' : `${2 * ctx.k}px`;
      el.style.background = pick(CONFETTI);
      parts.push(shot(ctx, ctx.world, el, frames, { duration: T * 1000, delay: rand(0, 120), easing: 'linear' }));
    }
    return group(parts);
  },

  dust(ctx, o) {
    const a = ctx.anchorWorld(o.anchor || 'ground');
    const n = o.count ?? 10;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const s = rand(18, 34) * ctx.k;
      const x0 = a.x + side * rand(0.05, 0.3) * ctx.width;
      const dx = side * rand(26, 70) * ctx.k;
      const dy = -rand(6, 22) * ctx.k;
      const el = node('nb-fx-dust', '', x0, a.y - s * 0.25);
      el.style.width = el.style.height = `${s}px`;
      parts.push(shot(ctx, ctx.world, el, [
        { transform: `${C} translate(0,0) scale(.35)`, opacity: 0 },
        { transform: `${C} translate(${dx * 0.4}px,${dy * 0.4}px) scale(1)`, opacity: 0.9, offset: 0.25 },
        { transform: `${C} translate(${dx}px,${dy}px) scale(1.5)`, opacity: 0 },
      ], { duration: rand(520, 780), delay: rand(0, 60), easing: 'cubic-bezier(.2,.8,.3,1)' }));
    }
    return group(parts);
  },

  sweat(ctx, o) {
    const a = ctx.anchorLocal(o.anchor || 'eyeR');
    const s = 15 * ctx.k;
    const x = a.x + 0.17 * ctx.width;
    const y = a.y - 0.07 * ctx.height;
    return group([shot(ctx, ctx.local, node('nb-fx-sweat', dropSvg(s), x, y), [
      { transform: `${C} translate(0,0) scale(.3) rotate(18deg)`, opacity: 0 },
      { transform: `${C} translate(0,0) scale(1.08) rotate(18deg)`, opacity: 1, offset: 0.18 },
      { transform: `${C} translate(${2 * ctx.k}px,${6 * ctx.k}px) scale(1) rotate(16deg)`, opacity: 1, offset: 0.7 },
      { transform: `${C} translate(${3 * ctx.k}px,${14 * ctx.k}px) scale(.9) rotate(14deg)`, opacity: 0 },
    ], { duration: o.duration ?? 1400, easing: 'cubic-bezier(.3,.7,.4,1)' })]);
  },

  zzz(ctx, o) {
    const total = o.duration ?? 3600;
    const parts = [];
    let alive = true;
    let cancel = null;
    let i = 0;
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const emitZ = () => {
      if (!alive) return;
      const a = ctx.anchorLocal(o.anchor || 'top');
      const s = (16 + (i % 3) * 5) * ctx.k;
      const x = a.x + 0.2 * ctx.width;
      const y = a.y + 0.06 * ctx.height;
      const p = shot(ctx, ctx.local, node('nb-fx-z', textSvg(s, 'z', '#9AA8FF', '#2E3878'), x, y), [
        { transform: `${C} translate(0,0) scale(.4) rotate(-10deg)`, opacity: 0 },
        { transform: `${C} translate(${8 * ctx.k}px,${-14 * ctx.k}px) scale(1) rotate(6deg)`, opacity: 1, offset: 0.3 },
        { transform: `${C} translate(${26 * ctx.k}px,${-52 * ctx.k}px) scale(1.1) rotate(-8deg)`, opacity: 0 },
      ], { duration: 1700, easing: 'cubic-bezier(.3,.6,.4,1)' });
      parts.push(p);
      i++;
      cancel = ctx.after(620, emitZ);
    };
    emitZ();
    const end = ctx.after(total, () => stop());
    function stop() {
      if (!alive) return;
      alive = false;
      if (cancel) cancel();
      end();
      Promise.all(parts.map((p) => p.done)).then(resolveDone);
    }
    return { stop, done };
  },

  exclaim(ctx, o) {
    return popSign(ctx, o, '!', '#FF6A3D');
  },

  question(ctx, o) {
    return popSign(ctx, o, '?', '#7C8CFF');
  },

  notes(ctx, o) {
    const a = ctx.anchorLocal(o.anchor || 'top');
    const n = o.count ?? 3;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? -1 : 1;
      const s = rand(15, 21) * ctx.k;
      const x = a.x + side * rand(0.18, 0.3) * ctx.width;
      const y = a.y + 0.12 * ctx.height;
      parts.push(shot(ctx, ctx.local, node('nb-fx-note', noteSvg(s, pick(['var(--nb-primary, #2BB3A3)', '#FF7A59', '#7C8CFF'])), x, y), [
        { transform: `${C} translate(0,0) scale(.3) rotate(${side * -12}deg)`, opacity: 0 },
        { transform: `${C} translate(${side * 6 * ctx.k}px,${-16 * ctx.k}px) scale(1) rotate(${side * 8}deg)`, opacity: 1, offset: 0.3 },
        { transform: `${C} translate(${side * -4 * ctx.k}px,${-36 * ctx.k}px) scale(1) rotate(${side * -6}deg)`, opacity: 0.9, offset: 0.65 },
        { transform: `${C} translate(${side * 10 * ctx.k}px,${-58 * ctx.k}px) scale(.9) rotate(0deg)`, opacity: 0 },
      ], { duration: rand(1400, 1800), delay: i * 380, easing: 'ease-out' }));
    }
    return group(parts);
  },

  puff(ctx, o) {
    const a = ctx.anchorLocal(o.anchor || 'mouth');
    const dir = o.dir ?? 1;
    const s = 26 * ctx.k;
    return group([shot(ctx, ctx.local, node('nb-fx-puff', puffSvg(s), a.x + dir * 10 * ctx.k, a.y), [
      { transform: `${C} translate(0,0) scale(.3)`, opacity: 0 },
      { transform: `${C} translate(${dir * 10 * ctx.k}px,${-2 * ctx.k}px) scale(.9)`, opacity: 0.85, offset: 0.3 },
      { transform: `${C} translate(${dir * 30 * ctx.k}px,${-10 * ctx.k}px) scale(1.35)`, opacity: 0 },
    ], { duration: o.duration ?? 1100, easing: 'cubic-bezier(.2,.7,.3,1)' })]);
  },

  bubbles(ctx, o) {
    const a = ctx.anchorWorld(o.anchor || 'chest');
    const n = o.count ?? 5;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const s = rand(7, 14) * ctx.k;
      const x = a.x + rand(-0.4, 0.4) * ctx.width;
      const y = a.y + rand(-0.05, 0.2) * ctx.height;
      const sway = rand(6, 14) * ctx.k * (Math.random() < 0.5 ? -1 : 1);
      const rise = rand(50, 90) * ctx.k;
      parts.push(shot(ctx, ctx.world, node('nb-fx-bubble', bubbleSvg(s), x, y), [
        { transform: `${C} translate(0,0) scale(.3)`, opacity: 0 },
        { transform: `${C} translate(${sway * 0.5}px,${-rise * 0.3}px) scale(1)`, opacity: 1, offset: 0.25 },
        { transform: `${C} translate(${-sway * 0.4}px,${-rise * 0.7}px) scale(1)`, opacity: 0.9, offset: 0.7 },
        { transform: `${C} translate(${sway}px,${-rise}px) scale(1.25)`, opacity: 0 },
      ], { duration: rand(1300, 2000), delay: i * 160, easing: 'ease-out' }));
    }
    return group(parts);
  },

  blush(ctx, o) {
    const ms = o.duration ?? 1800;
    ctx.setBlush(1, 180);
    const cancel = ctx.after(ms, () => ctx.setBlush(0, 600));
    return { stop: () => (cancel(), ctx.setBlush(0, 300)), done: new Promise((r) => ctx.after(ms + 600, r)) };
  },
};

function popSign(ctx, o, ch, color) {
  const a = ctx.anchorLocal(o.anchor || 'top');
  const s = 34 * ctx.k;
  const x = a.x + 0.24 * ctx.width;
  const y = a.y + 0.02 * ctx.height;
  return group([shot(ctx, ctx.local, node('nb-fx-sign', textSvg(s, ch, color, '#FFFFFF'), x, y), [
    { transform: `${C} scale(0) rotate(-20deg)`, opacity: 0 },
    { transform: `${C} scale(1.3) rotate(8deg)`, opacity: 1, offset: 0.16 },
    { transform: `${C} scale(.94) rotate(-4deg)`, opacity: 1, offset: 0.3 },
    { transform: `${C} scale(1) rotate(2deg)`, opacity: 1, offset: 0.75 },
    { transform: `${C} translateY(${-10 * ctx.k}px) scale(.8) rotate(0deg)`, opacity: 0 },
  ], { duration: o.duration ?? 1200, easing: 'ease-out' })]);
}

// Rain cloud that hovers above the head and follows the buddy (local layer). `storm` adds lightning flicker.
function cloud(ctx, o, storm) {
  const a = ctx.anchorLocal('top');
  const w = 112 * ctx.k;
  const wrap = node(`nb-fx-cloud${storm ? ' is-storm' : ''}`, '', a.x, a.y - 30 * ctx.k);
  const body = document.createElement('div');
  body.className = 'nb-fx-cloud-body';
  body.innerHTML = cloudSvg(w, storm);
  const rain = document.createElement('div');
  rain.className = 'nb-fx-rain';
  wrap.append(rain, body);
  ctx.local.appendChild(wrap);
  const anims = [];
  const track = (an) => (anims.push(ctx.track(an)), an);

  track(wrap.animate([
    { transform: `${C} translateY(${10 * ctx.k}px) scale(.5)`, opacity: 0 },
    { transform: `${C} translateY(0) scale(1.06)`, opacity: 1, offset: 0.7 },
    { transform: `${C} translateY(0) scale(1)`, opacity: 1 },
  ], { duration: 520, easing: 'cubic-bezier(.3,1.2,.5,1)', fill: 'forwards' }));
  track(body.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-3.5 * ctx.k}px)` }, { transform: 'translateY(0)' }],
    { duration: 2600, iterations: Infinity, easing: 'ease-in-out' }));

  const drops = storm ? 9 : 7;
  for (let i = 0; i < drops; i++) {
    const d = document.createElement('i');
    d.className = 'nb-fx-drop';
    d.style.left = `${18 + (i / (drops - 1)) * 64 + rand(-3, 3)}%`;
    d.style.width = `${3 * ctx.k}px`;
    d.style.height = `${(storm ? 11 : 9) * ctx.k}px`;
    rain.appendChild(d);
    const fall = (storm ? 74 : 62) * ctx.k;
    track(d.animate([
      { transform: 'translateY(0) scaleY(.6)', opacity: 0 },
      { transform: `translateY(${fall * 0.2}px) scaleY(1)`, opacity: 0.95, offset: 0.2 },
      { transform: `translateY(${fall}px) scaleY(1)`, opacity: 0 },
    ], { duration: storm ? rand(520, 680) : rand(720, 900), delay: rand(0, 900), iterations: Infinity, easing: 'cubic-bezier(.5,0,1,1)' }));
  }

  let bolt = null;
  let nextFlash = null;
  if (storm) {
    bolt = document.createElement('div');
    bolt.className = 'nb-fx-bolt';
    bolt.innerHTML = boltSvg(34 * ctx.k);
    wrap.appendChild(bolt);
    const flash = () => {
      track(bolt.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.15, offset: 0.2 }, { opacity: 1, offset: 0.32 }, { opacity: 0 }],
        { duration: 460, easing: 'linear' }));
      track(body.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.9)', offset: 0.1 }, { filter: 'brightness(1)', offset: 0.35 }, { filter: 'brightness(1.6)', offset: 0.45 }, { filter: 'brightness(1)' }],
        { duration: 520, easing: 'linear', composite: 'add' }));
      if (o.onFlash) o.onFlash();
      ctx.emit('flash');
      nextFlash = ctx.after(rand(1500, 2800), flash);
    };
    nextFlash = ctx.after(380, flash);
  }

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  let alive = true;
  const endTimer = Number.isFinite(o.duration ?? 6000) ? ctx.after(o.duration ?? 6000, () => stop()) : () => {};
  function stop() {
    if (!alive) return;
    alive = false;
    endTimer();
    if (nextFlash) nextFlash();
    const out = ctx.track(wrap.animate([{ opacity: 1, transform: `${C} scale(1)` }, { opacity: 0, transform: `${C} translateY(${-8 * ctx.k}px) scale(.85)` }],
      { duration: 420, easing: 'ease-in', fill: 'forwards' }));
    out.finished.finally(() => {
      anims.forEach((an) => an.cancel());
      wrap.remove();
      resolveDone();
    });
  }
  return { stop, done };
}

/** Plays effect `name`. Unknown names are ignored (returns an inert handle). */
export function playFx(ctx, name, opts = {}) {
  const fn = EFFECTS[name];
  if (!fn) return { stop() {}, done: Promise.resolve() };
  return fn(ctx, opts);
}
