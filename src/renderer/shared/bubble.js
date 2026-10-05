// Nudgi speech bubble.
//
//   const b = createBubble(host, { style: 'comic' | 'bubble', accent: '#12B5D0', sound: true });
//   b.placeAbove(headX, headY, { width, height });          // re-callable any time (cheap)
//   await b.show({ greeting, question, yesLabel, laterLabel, closable, onTalk });
//   b.onAnswer((outcome) => …);                             // 'yes' | 'later' | 'dismiss', once per show()
//   await b.reply(text, { mood, goal: { count, total, shape: 'drop' | 'dot' }, extra });
//   b.setCountdown(0..1); await b.hide(); b.destroy();
//
// Text is built per grapheme inside atomic word boxes, so the question can typewrite without ever
// re-wrapping, emoji stay in full colour (they are never gradient-clipped) and every word can wobble.
// The comic outline is a separate layer stacked under all fill layers, so it reads as a clean outer
// stroke. Content changes morph (FLIP-style size spring) instead of jumping.
import { sfx } from './sound.js';

const TYPE_MS = 28;
const EDGE = 16;
const TAIL = { w: 28, h: 13, inset: 30 };
const MAX_W = { comic: 376, bubble: 320 };
// [stiffness, damping] for unit-mass springs, rendered as CSS linear() easings
const SPRINGS = { pop: [240, 15], word: [320, 14], size: [250, 26], button: [380, 20], droop: [150, 17] };

const CLOSE_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 1.6l6.8 6.8M8.4 1.6L1.6 8.4" fill="none"/></svg>';
const TAIL_SVG =
  '<svg class="nbb-tail" viewBox="0 0 28 13" aria-hidden="true"><path d="M0 0h28c-6.5 0-10.2 3.4-12.3 10.6-.5 1.6-1.1 2.4-1.7 2.4s-1.2-.8-1.7-2.4C10.2 3.4 6.5 0 0 0Z"/></svg>';
const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0c.9 6.6 4.5 10.6 12 12-7.5 1.4-11.1 5.4-12 12-.9-6.6-4.5-10.6-12-12C7.5 10.6 11.1 6.6 12 0Z"/></svg>';

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (SEGMENTER ? Array.from(SEGMENTER.segment(s), (g) => g.segment) : Array.from(s));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Untransformed layout width, rounded up so pinning an element never makes its content re-wrap.
const pinWidth = (el) => `${Math.ceil(parseFloat(getComputedStyle(el).width) || el.offsetWidth)}px`;

function h(tag, cls, attrs) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---- one-time page setup ---------------------------------------------------------------------
let stylesReady = null;
function ensureStyles() {
  if (stylesReady) return stylesReady;
  const href = new URL('./bubble.css', import.meta.url).href;
  let link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === href);
  if (link && link.sheet) return (stylesReady = Promise.resolve());
  if (!link) {
    link = h('link', '', { rel: 'stylesheet', href });
    document.head.append(link);
  }
  stylesReady = new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
  });
  return stylesReady;
}

let fontsReady = null;
function ensureFonts() {
  if (!fontsReady) {
    const f = document.fonts;
    fontsReady = f
      ? Promise.race([Promise.all([f.load("700 32px 'Fredoka'"), f.load("600 16px 'Fredoka'")]), wait(1500)]).catch(() => {})
      : Promise.resolve();
  }
  return fontsReady;
}
const ready = () => ensureStyles().then(ensureFonts);

// Spring step response sampled into a CSS linear() easing (cached per preset).
const springCache = new Map();
function spring([k, c]) {
  const key = `${k}/${c}`;
  if (springCache.has(key)) return springCache.get(key);
  const dt = 1 / 600;
  const xs = [];
  let x = 0;
  let v = 0;
  let calm = 0;
  for (let t = 0; t < 2.5; t += dt) {
    v += (-k * (x - 1) - c * v) * dt;
    x += v * dt;
    xs.push(x);
    calm = Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.03 ? calm + dt : 0;
    if (calm > 0.04) break;
  }
  const n = 64;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(+xs[Math.round((i / n) * (xs.length - 1))].toFixed(4));
  pts.push(1);
  const out = { duration: Math.round(xs.length * dt * 1000), easing: `linear(${pts.join(', ')})` };
  springCache.set(key, out);
  return out;
}

// Readable ink for an accent background: white when it passes 4.5:1, otherwise a deep shade of the accent.
function accentInk(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const full = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1];
  const n = parseInt(full, 16);
  const lin = [n >> 16, (n >> 8) & 255, n & 255].map((u) => {
    const s = u / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return { accent: `#${full}`, ink: 1.05 / (lum + 0.05) >= 4.5 ? '#ffffff' : `color-mix(in oklab, #${full}, #000 72%)` };
}

// ---- text ------------------------------------------------------------------------------------
function lengthClass(n) {
  return n > 52 ? 'nbb-len-l' : n > 28 ? 'nbb-len-m' : '';
}

// Builds one text line. Each word is an inline-grid holding the fill layer (and, for comic, the
// outline layer beneath it). Graphemes are separate spans so typing only toggles visibility.
function buildText(text, cls, { outline, hidden = false }) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const all = graphemes(clean);
  const el = h('div', ['nbb-text', cls, lengthClass(all.length)].filter(Boolean).join(' '));
  const sr = h('span', 'nbb-sr');
  sr.textContent = clean;
  el.append(sr);
  const units = [];
  const words = [];
  if (!clean) return { el, units, words, text: clean };
  clean.split(' ').forEach((word, wi) => {
    if (wi) {
      el.append(' ');
      units.push({ spans: [], char: ' ' });
    }
    const w = h('span', 'nbb-word', { 'aria-hidden': 'true' });
    const layers = outline ? [h('span', 'nbb-s'), h('span', 'nbb-f')] : [h('span', 'nbb-f')];
    w.append(...layers);
    const runs = layers.map(() => null);
    graphemes(word).forEach((g, gi) => {
      const emoji = EMOJI.test(g);
      const spans = layers.map((layer, li) => {
        const s = h('span', emoji ? 'nbb-emo' : null);
        s.textContent = g;
        if (hidden) s.classList.add('nbb-h');
        if (emoji) {
          layer.append(s);
          runs[li] = null;
        } else {
          if (!runs[li]) layer.append((runs[li] = h('span', 'nbb-run')));
          runs[li].append(s);
        }
        return s;
      });
      units.push({ spans, char: g, word: gi === 0 ? w : null });
    });
    words.push(w);
    el.append(w);
  });
  return { el, units, words, text: clean };
}

// Typing schedule: steady rhythm with small breaths after punctuation.
function typePlan(units) {
  const times = [];
  let t = 0;
  units.forEach((u, i) => {
    times.push(t);
    if (i === units.length - 1) return;
    t += TYPE_MS + (/[,;:]/.test(u.char) ? 90 : /[.!?…]/.test(u.char) ? 150 : 0);
  });
  return { times, total: t + TYPE_MS };
}

// Narrows a wrapped text box to its widest balanced line so the bubble hugs the text.
function tighten(content) {
  const texts = [...content.querySelectorAll('.nbb-text')];
  for (const t of texts) t.style.width = '';
  const widths = texts.map((t) => {
    let lines = 0;
    let widest = 0;
    let left = 0;
    let right = 0;
    let lastTop = -1e9;
    let lastH = 0;
    for (const w of t.children) {
      if (!w.classList.contains('nbb-word')) continue;
      const top = w.offsetTop;
      if (top > lastTop + lastH * 0.5) {
        if (lines) widest = Math.max(widest, right - left);
        lines++;
        left = w.offsetLeft;
        lastTop = top;
        lastH = w.offsetHeight;
      }
      right = w.offsetLeft + w.offsetWidth;
    }
    widest = Math.max(widest, right - left);
    return lines > 1 ? Math.ceil(widest) + 2 : 0;
  });
  texts.forEach((t, i) => {
    if (widths[i]) t.style.width = `${widths[i]}px`;
  });
}

// ---- component -------------------------------------------------------------------------------
export function createBubble(host, { style = 'comic', accent = null, sound = true } = {}) {
  const root = h('div', 'nbb-bubble', { role: 'group', 'aria-roledescription': 'speech bubble', 'data-state': 'hidden' });
  const box = h('div', 'nbb-box');
  const float = h('div', 'nbb-float');
  const shape = h('div', 'nbb-shape');
  const card = h('div', 'nbb-card', { 'data-nbb-hit': '' });
  const stage = h('div', 'nbb-stage', { 'aria-live': 'polite' });
  const close = h('button', 'nbb-close', { type: 'button', 'aria-label': 'Dismiss', 'data-outcome': 'dismiss' });
  close.innerHTML = CLOSE_SVG;
  card.append(stage);
  shape.append(card);
  shape.insertAdjacentHTML('beforeend', TAIL_SVG);
  const tail = shape.lastElementChild;
  float.append(shape, close);
  box.append(float);
  root.append(box);
  host.append(root);

  let look = style === 'bubble' ? 'bubble' : 'comic';
  let state = 'hidden';
  let seq = 0; // bumps on every show/reply/hide; async steps bail out when stale
  let answered = false;
  let closable = true;
  let current = null; // the visible .nbb-content
  let timerEl = null;
  let morph = null;
  let place = null;
  let geo = { w: 0, h: 0, L: 0, Y: 0, tailX: 0, ox: 0 };
  let last = null; // last render, so setStyle() can rebuild in place
  let destroyed = false;
  const listeners = new Set();
  const anims = new Set();

  root.classList.add(`nbb-style-${look}`);
  setAccent(accent);
  ensureStyles();

  const track = (a) => {
    anims.add(a);
    const done = () => anims.delete(a);
    a.addEventListener('finish', done);
    a.addEventListener('cancel', done);
    return a;
  };
  const setState = (s) => {
    state = s;
    root.dataset.state = s;
  };

  // ---- geometry ----
  function bounds() {
    if (place) return place;
    return { x: host.clientWidth / 2, y: host.clientHeight - 8, bw: host.clientWidth, bh: host.clientHeight };
  }

  // Returns true when the usable width changed (text may need to re-wrap).
  function updateMax() {
    const b = bounds();
    const max = `${Math.max(150, Math.min(MAX_W[look], b.bw - 2 * EDGE))}px`;
    if (root.style.getPropertyValue('--nbb-max') === max) return false;
    root.style.setProperty('--nbb-max', max);
    return true;
  }

  function computeGeo(w, hgt) {
    const b = bounds();
    const tailH = look === 'bubble' ? TAIL.h : 0;
    const L = w > b.bw - 2 * EDGE ? (b.bw - w) / 2 : clamp(b.x - w / 2, EDGE, b.bw - EDGE - w);
    const Y = Math.max(b.y - (look === 'bubble' ? 6 : 4) - tailH, EDGE + hgt);
    const tailX = clamp(b.x - L, TAIL.inset, w - TAIL.inset);
    // When the tail is clamped away from the anchor (screen edges), it leans toward it instead.
    const lean = clamp(b.x - L - tailX, -12, 12);
    const ox = look === 'bubble' ? tailX : clamp(b.x - L, 0, w);
    return { w, h: hgt, L: Math.round(L), Y: Math.round(Y), tailX: Math.round(tailX), lean, ox: Math.round(ox) };
  }

  const tailSkew = (g) => `skewX(${((Math.atan2(g.lean || 0, TAIL.h) * 180) / Math.PI).toFixed(2)}deg)`;

  function applyGeo(g) {
    geo = g;
    root.style.translate = `${g.L}px ${g.Y}px`;
    tail.style.left = `${g.tailX - TAIL.w / 2}px`;
    tail.style.transform = tailSkew(g);
    box.style.transformOrigin = `${g.ox}px calc(100% + ${look === 'bubble' ? TAIL.h : 0}px)`;
  }

  // Natural size of the current content, after hugging wrapped lines.
  function measure() {
    updateMax();
    if (current) tighten(current);
    return computeGeo(card.offsetWidth, card.offsetHeight);
  }

  function layout() {
    if (morph || state === 'hidden') return;
    applyGeo(computeGeo(card.offsetWidth, card.offsetHeight));
  }

  // Visual geometry right now (mid-animation values included).
  function visualGeo() {
    const cs = getComputedStyle(card);
    const [tx, ty] = (getComputedStyle(root).translate || '').split(' ').map(parseFloat);
    const tailCs = getComputedStyle(tail);
    const tailLeft = parseFloat(tailCs.left);
    return {
      tailTransform: tailCs.transform === 'none' ? 'skewX(0deg)' : tailCs.transform,
      w: parseFloat(cs.width) || geo.w,
      h: parseFloat(cs.height) || geo.h,
      L: Number.isFinite(tx) ? tx : geo.L,
      Y: Number.isFinite(ty) ? ty : geo.Y,
      tailX: Number.isFinite(tailLeft) ? tailLeft + TAIL.w / 2 : geo.tailX,
    };
  }

  function settleMorph() {
    if (!morph) return;
    const m = morph;
    morph = null;
    for (const a of m.anims) a.cancel();
    for (const n of m.outgoing) n.remove();
    if (current) {
      current.classList.remove('nbb-pinned');
      current.style.width = '';
    }
    card.style.width = '';
    card.style.height = '';
    applyGeo(computeGeo(card.offsetWidth, card.offsetHeight)); // picks up anchors that moved meanwhile
  }

  // Springs the card from one size/position to another while contents stay pinned bottom-centre.
  function animateResize(from, to, outgoing = []) {
    current.style.width = pinWidth(current);
    current.classList.add('nbb-pinned');
    card.style.width = `${to.w}px`;
    card.style.height = `${to.h}px`;
    const sp = spring(SPRINGS.size);
    const m = {
      outgoing,
      anims: [
        track(card.animate([{ width: `${from.w}px`, height: `${from.h}px` }, { width: `${to.w}px`, height: `${to.h}px` }], sp)),
        track(root.animate([{ translate: `${from.L}px ${from.Y}px` }, { translate: `${to.L}px ${to.Y}px` }], sp)),
        track(tail.animate(
          [
            { left: `${from.tailX - TAIL.w / 2}px`, transform: from.tailTransform || tailSkew(from) },
            { left: `${to.tailX - TAIL.w / 2}px`, transform: tailSkew(to) },
          ],
          sp,
        )),
      ],
    };
    for (const n of outgoing) {
      m.anims.push(
        track(n.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.94)' }], {
          duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards',
        })),
      );
    }
    morph = m;
    Promise.all(m.anims.map((a) => a.finished))
      .then(() => morph === m && settleMorph())
      .catch(() => {});
  }

  // Replace the visible content: pop in when hidden, morph when already showing.
  function swapIn(fresh, calm) {
    const visible = state === 'asking' || state === 'reply';
    if (!visible || !current) {
      settleMorph();
      for (const a of anims) if (a.effect?.target === box) a.cancel();
      stage.replaceChildren(fresh);
      current = fresh;
      applyGeo(measure());
      return popIn(calm);
    }
    const from = visualGeo();
    settleMorph();
    const old = current;
    old.style.width = pinWidth(old);
    old.classList.add('nbb-pinned', 'nbb-out');
    stage.append(fresh);
    current = fresh;
    const to = measure();
    applyGeo(to);
    if (calm) old.remove();
    else animateResize(from, to, [old]);
  }

  // Smoothly absorbs a size change of the current content (e.g. the goal label growing).
  function resizeSmoothly(mutate) {
    const from = visualGeo();
    settleMorph();
    mutate();
    const to = measure();
    applyGeo(to);
    if (!reducedMotion()) animateResize(from, to);
  }

  function popIn(calm) {
    if (calm) {
      track(box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' }));
      return;
    }
    const from = look === 'comic' ? 'translateY(14px) scale(0.35) rotate(-9deg)' : 'translateY(10px) scale(0.55)';
    track(box.animate([{ transform: from }, { transform: 'none' }], spring(SPRINGS.pop)));
    track(box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' }));
  }

  // ---- motion helpers ----
  function wobbleWords(words, { delay = 0, mood = 'neutral' } = {}) {
    const sad = mood === 'sad';
    const sp = spring(sad ? SPRINGS.droop : SPRINGS.word);
    words.forEach((w, i) => {
      const d = delay + i * 55;
      const tilt = (i % 2 ? 1 : -1) * (look === 'comic' ? 11 : 4);
      const from = sad
        ? `translateY(-0.4em) rotate(${tilt * 0.4}deg)`
        : look === 'comic'
          ? `translateY(0.5em) scale(0.3) rotate(${tilt}deg)`
          : 'translateY(0.35em) scale(0.75)';
      track(w.animate([{ transform: from }, { transform: 'none' }], { ...sp, delay: d, fill: 'backwards' }));
      track(w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay: d, easing: 'ease-out', fill: 'backwards' }));
    });
  }

  function hop(word) {
    if (look !== 'comic') return;
    track(word.animate(
      [{ transform: 'none' }, { transform: 'translateY(-0.12em) scale(1.06)' }, { transform: 'none' }],
      { duration: 240, easing: 'ease-out' },
    ));
  }

  function typeOut(line, plan, alive) {
    return new Promise((resolve) => {
      const start = performance.now();
      let i = 0;
      const tick = () => {
        if (!alive()) return resolve();
        const now = performance.now() - start;
        while (i < line.units.length && plan.times[i] <= now) {
          const u = line.units[i++];
          for (const s of u.spans) s.classList.remove('nbb-h');
          if (u.word) hop(u.word);
        }
        if (i >= line.units.length) return resolve();
        setTimeout(tick, Math.max(4, plan.times[i] - now));
      };
      tick();
    });
  }

  function revealButtons(btns, calm) {
    btns.forEach((b, i) => {
      b.classList.remove('nbb-pending');
      if (calm) return;
      const d = i * 70;
      track(b.animate([{ transform: 'translateY(8px) scale(0.6)' }, { transform: 'none' }], { ...spring(SPRINGS.button), delay: d, fill: 'backwards' }));
      track(b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 130, delay: d, easing: 'ease-out', fill: 'backwards' }));
    });
    btns[0]?.classList.add('nbb-ready');
  }

  function sparkle(target) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const s = h('span', 'nbb-spark', { 'aria-hidden': 'true' });
      s.innerHTML = STAR_SVG;
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5 - 0.25;
      const size = 11 + Math.random() * 9;
      s.style.setProperty('--s', `${size.toFixed(1)}px`);
      s.style.setProperty('--d', `${100 + i * 85}ms`);
      // on an ellipse just outside the text box, whatever its size
      const cx = Math.cos(a).toFixed(3);
      const cy = Math.sin(a).toFixed(3);
      s.style.left = `calc(50% + ${cx} * (50% + 14px) - ${(size / 2).toFixed(1)}px)`;
      s.style.top = `calc(50% + ${cy} * (50% + 10px) - ${(size / 2).toFixed(1)}px)`;
      s.addEventListener('animationend', () => s.remove(), { once: true });
      target.append(s);
    }
  }

  // ---- content builders ----
  function makeButton(label, outcome, cls) {
    const b = h('button', `nbb-btn ${cls}`, { type: 'button', 'data-outcome': outcome });
    b.textContent = String(label ?? '').trim() || (outcome === 'yes' ? 'Yes' : 'Later');
    return b;
  }

  function normalizeGoal(goal) {
    if (!goal || !(Number(goal.total) > 0)) return null;
    const total = clamp(Math.round(goal.total), 1, 30);
    // `actual` may exceed the goal (a 9th glass of 8): pips stay full, the counter keeps the true number.
    const actual = Math.max(0, Math.round(Number(goal.count) || 0));
    const count = Math.min(actual, total);
    return { total, count, actual, over: actual > total, shape: goal.shape === 'dot' ? 'dot' : 'drop', done: count >= total };
  }

  function buildGoal(g) {
    const el = h('div', 'nbb-goal', {
      role: 'img',
      'aria-label': `${g.actual} of ${g.total} today`,
    });
    const size = g.total <= 8 ? '' : g.total <= 12 ? 'nbb-m' : g.total <= 20 ? 'nbb-s' : 'nbb-xs';
    const pips = h('div', ['nbb-pips', size].filter(Boolean).join(' '), { 'aria-hidden': 'true' });
    const list = [];
    for (let i = 0; i < g.total; i++) {
      const p = h('span', `nbb-pip nbb-pip-${g.shape}`);
      p.append(h('b'), h('i'));
      if (i < (g.over ? g.total : g.count - 1)) p.classList.add('is-on');
      pips.append(p);
      list.push(p);
    }
    const label = h('span', 'nbb-goal-label', { 'aria-hidden': 'true' });
    const num = h('b');
    const setCount = (n) => {
      num.textContent = String(n);
      label.replaceChildren(num, ` / ${g.total} today`);
    };
    setCount(Math.max(0, g.actual - 1));
    el.append(pips, label);
    const fresh = !g.over && g.count > 0 ? list[g.count - 1] : null;

    const markDone = (animate) => {
      // visual only (golden pips): the counter stays the sole non-configured text
      const apply = () => el.classList.add('nbb-goal-done');
      if (!animate) return apply();
      resizeSmoothly(apply);
      track(label.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], spring(SPRINGS.pop)));
      list.forEach((p, i) => {
        track(p.animate(
          [{ transform: 'none' }, { transform: 'translateY(-5px) scale(1.15)' }, { transform: 'none' }],
          { duration: 460, delay: i * 45, easing: 'ease-in-out' },
        ));
      });
    };

    return {
      el,
      settle() {
        fresh?.classList.add('is-on');
        setCount(g.actual);
        if (g.done) markDone(false);
      },
      async play(alive) {
        if (fresh) {
          fresh.classList.add('is-on');
          const [fill, ring] = fresh.children;
          track(fill.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], spring(SPRINGS.pop)));
          track(ring.animate([{ opacity: 0.9, transform: 'scale(0.35)' }, { opacity: 0, transform: 'scale(1.7)' }], {
            duration: 680, easing: 'cubic-bezier(.2,.7,.3,1)',
          }));
          setCount(g.actual);
          track(num.animate([{ transform: 'translateY(-0.5em) scale(1.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], spring(SPRINGS.pop)));
          if (sound) sfx.play('pop');
          await wait(g.done ? 420 : 320);
          if (!alive()) return;
        }
        if (g.over) {
          // already past the goal: count up without re-running the goal celebration
          setCount(g.actual);
          track(num.animate([{ transform: 'translateY(-0.5em) scale(1.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], spring(SPRINGS.pop)));
          markDone(false);
        } else if (g.done) {
          markDone(true);
          await wait(650);
        }
      },
    };
  }

  // ---- public: show ----
  async function show(opts = {}) {
    const my = ++seq;
    const { greeting = '', question = '', yesLabel = 'Yes', laterLabel = 'Later', onTalk = null, instant = false } = opts;
    last = { kind: 'ask', opts: { greeting, question, yesLabel, laterLabel, closable: opts.closable !== false } };
    await ready();
    if (my !== seq || destroyed) return;
    const calm = instant || reducedMotion();
    const outline = look === 'comic';

    answered = false;
    closable = opts.closable !== false;
    root.classList.remove('nbb-answered');
    root.dataset.mood = 'neutral';
    close.hidden = !closable;

    const content = h('div', 'nbb-content nbb-ask');
    const greet = greeting ? buildText(greeting, 'nbb-greeting', { outline }) : null;
    const q = buildText(question, 'nbb-question', { outline, hidden: !calm });
    const actions = h('div', 'nbb-actions');
    const btns = [makeButton(yesLabel, 'yes', 'nbb-primary'), makeButton(laterLabel, 'later', 'nbb-secondary')];
    if (!calm) btns.forEach((b) => b.classList.add('nbb-pending'));
    timerEl = h('i', 'nbb-timer', { 'aria-hidden': 'true' });
    btns[1].append(timerEl);
    actions.append(...btns);
    if (greet) content.append(greet.el);
    content.append(q.el, actions);

    const wasVisible = state === 'asking' || state === 'reply';
    swapIn(content, calm);
    setState('asking');

    if (calm) {
      revealButtons(btns, true);
      if (onTalk && !instant) onTalk(clamp((greet ? greet.text.length : 0) * 45 + q.text.length * 35, 400, 2600));
      return;
    }
    const alive = () => my === seq && !destroyed;
    if (greet) {
      wobbleWords(greet.words, { delay: wasVisible ? 60 : 90 });
      onTalk?.(clamp(greet.text.length * 55, 350, 1100));
      await wait(300 + greet.words.length * 55);
    } else await wait(140);
    if (!alive()) return;
    const plan = typePlan(q.units);
    onTalk?.(plan.total);
    await typeOut(q, plan, alive);
    if (!alive()) return;
    await wait(90);
    if (!alive()) return;
    revealButtons(btns, false);
    await wait(380);
  }

  // ---- public: reply ----
  async function reply(text, { mood = 'neutral', goal = null, extra = null, instant = false } = {}) {
    const my = ++seq;
    last = { kind: 'reply', text, opts: { mood, goal, extra } };
    await ready();
    if (my !== seq || destroyed) return;
    const calm = instant || reducedMotion();
    const outline = look === 'comic';
    const m = mood === 'happy' || mood === 'sad' ? mood : 'neutral';
    const g = normalizeGoal(goal);

    answered = true;
    root.classList.add('nbb-answered');
    timerEl = null;

    const content = h('div', `nbb-content nbb-reply nbb-mood-${m}`);
    const extraText = String(extra ?? '').trim();
    const extraLine = extraText && !(g?.done && /goal reached/i.test(extraText)) ? buildText(extraText, 'nbb-extra', { outline }) : null;
    const main = buildText(text, 'nbb-replytext', { outline });
    const goalRow = g ? buildGoal(g) : null;
    if (extraLine) content.append(extraLine.el);
    content.append(main.el);
    if (goalRow) content.append(goalRow.el);

    root.dataset.mood = m;
    swapIn(content, calm);
    setState('reply');

    if (calm) {
      if (goalRow) {
        goalRow.settle();
        applyGeo(measure());
      }
      return;
    }
    const alive = () => my === seq && !destroyed;
    const words = [...(extraLine ? extraLine.words : []), ...main.words];
    wobbleWords(words, { delay: 70, mood: m });
    if (m === 'happy') sparkle(main.el);
    await wait(380 + words.length * 45);
    if (!alive()) return;
    if (goalRow) await goalRow.play(alive);
  }

  // ---- public: hide / misc ----
  let hiding = null;
  function hide() {
    if (state === 'hidden') return Promise.resolve();
    if (state === 'hiding' && hiding) return hiding;
    return (hiding = hideNow().finally(() => (hiding = null)));
  }

  async function hideNow() {
    const my = ++seq;
    settleMorph();
    for (const a of anims) if (a.effect?.target === box) a.finish();
    setState('hiding');
    const to = reducedMotion()
      ? { opacity: 0 }
      : { opacity: 0, transform: look === 'comic' ? 'translateY(12px) scale(0.6) rotate(5deg)' : 'translateY(8px) scale(0.85)' };
    const a = track(box.animate([{ opacity: 1, transform: 'none' }, to], {
      duration: reducedMotion() ? 140 : 230, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards',
    }));
    await a.finished.catch(() => {});
    if (my !== seq || destroyed) return;
    a.cancel();
    setState('hidden');
    stage.replaceChildren();
    current = null;
    timerEl = null;
  }

  function answer(outcome, btn) {
    if (answered || state !== 'asking') return;
    if (outcome === 'dismiss' && !closable) return;
    answered = true;
    root.classList.add('nbb-answered');
    current?.querySelectorAll('.nbb-btn').forEach((b) => (b.disabled = true));
    if (btn && btn !== close) {
      btn.classList.add('nbb-chosen');
      track(btn.animate([{ transform: 'none' }, { transform: 'scale(1.1)' }, { transform: 'none' }], { duration: 280, easing: 'ease-out' }));
    }
    if (sound) sfx.play('tap');
    setCountdown(0);
    for (const cb of [...listeners]) {
      try {
        cb(outcome);
      } catch (err) {
        console.error('[bubble] onAnswer handler failed', err);
      }
    }
  }

  function setCountdown(f) {
    if (!timerEl) return;
    const v = clamp(Number(f) || 0, 0, 1);
    timerEl.classList.toggle('is-on', v > 0 && state === 'asking' && !answered);
    timerEl.classList.toggle('is-late', v > 0.8);
    timerEl.style.transform = `scaleX(${v.toFixed(4)})`;
  }

  function setAccent(hex) {
    const a = accentInk(hex) || accentInk('#12B5D0');
    root.style.setProperty('--nbb-accent', a.accent);
    root.style.setProperty('--nbb-accent-ink', a.ink);
  }

  // Switch look; visible content is rebuilt in place without replaying the entrance.
  function setStyle(next) {
    const s = next === 'bubble' ? 'bubble' : 'comic';
    if (s === look) return;
    root.classList.replace(`nbb-style-${look}`, `nbb-style-${s}`);
    look = s;
    if (state !== 'asking' && state !== 'reply') return;
    settleMorph();
    stage.replaceChildren();
    current = null;
    const wasAnswered = answered;
    if (last?.kind === 'reply') {
      reply(last.text, { ...last.opts, instant: true });
      return;
    }
    show({ ...last.opts, instant: true }).then(() => {
      if (!wasAnswered || state !== 'asking') return;
      answered = true;
      root.classList.add('nbb-answered');
      current?.querySelectorAll('.nbb-btn').forEach((b) => (b.disabled = true));
    });
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-outcome]');
    if (b && root.contains(b) && !b.disabled) answer(b.dataset.outcome, b);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer('dismiss', close);
  });

  return {
    el: root,
    get state() {
      return state;
    },
    show,
    reply,
    hide,
    onAnswer(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setCountdown,
    placeAbove(x, y, b = {}) {
      place = { x, y, bw: b.width ?? host.clientWidth, bh: b.height ?? host.clientHeight };
      if (state === 'hidden') return;
      if (morph) return; // the running morph re-applies geometry when it settles
      if (updateMax()) applyGeo(measure());
      else layout();
    },
    isInteractiveTarget(el) {
      if (!el || state !== 'asking' || answered || !root.contains(el)) return false;
      return !!el.closest('[data-nbb-hit], .nbb-close');
    },
    setStyle,
    setAccent,
    destroy() {
      destroyed = true;
      seq++;
      for (const a of [...anims]) a.cancel();
      morph = null;
      listeners.clear();
      root.remove();
    },
  };
}
