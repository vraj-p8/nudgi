/*
 * Nudgi — avatar engine
 * ===========================
 * Procedural, spring-driven 2D rig for the desktop buddies. One rAF ticker drives every live avatar; each frame
 * writes at most one `transform` attribute per moving part.
 *
 *   import { createAvatar, AVATARS, PROPS, ACTIONS, MOVES } from '../shared/avatar-engine.js';
 *   const av = createAvatar(host, { avatarId: 'nova', height: 250, prop: 'bottle' });
 *   await av.walkTo(400); await av.pose('present'); await av.play('drink');
 *
 * ---------------------------------------------------------------------------------------------------------------
 * 1. AVATAR DEFINITION CONTRACT  (shared/avatars/<id>.js, default export, plain data — never import the engine)
 * ---------------------------------------------------------------------------------------------------------------
 *   {
 *     id, name, tagline,
 *     locomotion: 'walk' | 'hop',
 *     colors: { primary, secondary, accent? },        // defaults for --nb-primary / --nb-secondary / --nb-accent
 *     pivots:  { body, torso, head, face?, armL, forearmL, armR, forearmR, legL, legR, tail?, earL?, earR?, antenna?, … },
 *     anchors: { top, mouth, earR, earL?, chest, handL, handR, eyeL, eyeR, ground },
 *     anchorParents?: { name: 'part' },                // override which part an anchor rides on (see defaults below)
 *     svg: `…inner markup, no outer <svg>…`,
 *     poses?:   { poseName: PoseValues },              // per-avatar overrides, merged part-by-part over engine poses
 *     actions?: { actionName: async (ctx, opts) => {} },   // replace / add whole actions (see §4)
 *     idle?:    (ictx, t, dt) => PartValues,           // additive extras every frame (tail sway, antenna bob, …)
 *     tuning?:  { faceTurn: 7, pupil: [4.2, 3.4], walkSpeed: 1, stride: 1, lift: 1, hopHeight: 1, hopLength: 1,
 *                 breath: 1, sway: 1, armSwing: 1, propScale: 1 },
 *     onExpression?: ({ el, svg, av, state }, name) => void,   // hook after an expression change (e.g. filters)
 *   }
 *
 *   Space: viewBox is always 0 0 200 300, feet on y = 300, centred on x = 100, head top ≈ y 20–30.
 *   "L" = screen-left, "R" = screen-right; the prop is held in the R hand.
 *   Standard skeleton (shared poses + IK assume it): neck (100,152), hips (100,236), shoulders (70,166)/(130,166),
 *   elbows (66,199)/(134,199), hands (64,230)/(136,230), hip joints (88,236)/(112,236).
 *   Skeleton lengths come from pivots + hand anchors (upper arm = shoulder→elbow, forearm = elbow→hand,
 *   leg = hip→ground), so a longer-armed robot just moves its pivots.
 *
 *   Parts: any element with data-part="name" that has a pivot is engine-driven (rot, x, y, sx, sy about its pivot).
 *   Do not put transform attributes on data-part / data-variant / data-slot elements; wrap inner shapes instead.
 *   Required nesting (draw order matters — armL before head, armR after head so a raised prop passes in front):
 *     body > [tail?] legL legR torso > [torso shapes] armL > forearmL ; head > [hair, ears…] face ; armR > forearmR
 *   face contains data-variant groups "set:value"; the engine shows exactly one value per set (opacity):
 *     eyes:open (holds data-part="pupils") | eyes:happy | eyes:sad | eyes:closed | optional eyes:love, eyes:wink
 *     brows:neutral | brows:sad | brows:raised          (optional set)
 *     mouth:smile | mouth:grin | mouth:sad | mouth:o | mouth:flat
 *     data-part="blush" (engine fades opacity 0..1)
 *   Variant sets may live anywhere (e.g. handL:open / handL:thumb on the L hand). Missing values fall back
 *   (love→happy, wink→happy, grin→smile, …); missing sets/parts are skipped.
 *   Special parts (not pivot-driven): pupils (look offset), blush (opacity), grip (front fingers on the R hand: they
 *   are counter-rotated together with the prop, hidden for prop 'none'), water (inside props).
 *   Prop slot: <g data-slot="prop"/> inside forearmR at the hand, between the hand back and the grip fingers.
 *
 *   Secondary-motion attributes (on any inner element; the engine owns that element's transform):
 *     data-parallax="k"                 shifts x by k * turn (3/4 view illusion: + toward the turn, − away)
 *     data-jiggle="hang|spring|bounce"  + data-pivot="x y" (+ optional data-amount="1")
 *         hang   — pendulum that hangs toward world-down and swings with motion (drawstrings, charms)
 *         spring — upright stalk that lags and wobbles back (cowlick, antenna, ears)
 *         bounce — soft mass that lags vertically (hair volume, cheeks)
 *
 *   Ids inside svg must be prefixed with the avatar id (`nova-skin`); every instance additionally namespaces
 *   id / url(#…) / href="#…". Themable colours: style="fill: var(--nb-primary)" or
 *   style="stop-color: color-mix(in oklab, var(--nb-primary), black 25%)" (presentation attributes can't use var()).
 *   Gradients used by several shapes that must match (skin on eyelids) should use gradientUnits="userSpaceOnUse".
 *
 *   Anchor parents (default): top/earL/earR → head; mouth/eyeL/eyeR → face (falls back to head); chest → torso;
 *   handL → forearmL; handR → forearmR; ground → body. Missing parts fall back to the nearest existing ancestor.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * 2. VALUES, SIGNS & POSES
 * ---------------------------------------------------------------------------------------------------------------
 *   PartValues = { part: { rot, x, y, sx, sy } } in degrees / avatar units. rot > 0 is clockwise on screen:
 *     armL rot > 0 swings the L arm outward (left), armR rot < 0 swings the R arm outward (right);
 *     forearmL rot < 0 / forearmR rot > 0 bends the elbow so the hand comes inward/up; body rot > 0 leans right.
 *   Virtual channels animate like parts: prop { tilt } (world degrees, − = top toward the face), look { x, y }
 *   (pupils, −1..1), view { turn } (−1 left … 1 right 3/4 turn), mouth { open } (scale of mouth:o, 1 = normal).
 *   PoseValues = PartValues + optional { ik: { L|R: target }, expression, faceSets: { eyes|brows|mouth },
 *     variants: { set: value }, front: ['armL'], propOverride: 'umbrella', mirror: true }.
 *     mirror: body/torso/head rot, view.turn and look.x flip with the facing direction (e.g. 'peek').
 *   Engine poses: idle, present, wave, shrug, sad, happy, think, peek, umbrella. Override any value per avatar:
 *     poses: { present: { ik: { R: [152, 184] } }, sad: { tail: { rot: 20 } } }
 *
 * ---------------------------------------------------------------------------------------------------------------
 * 3. MOTION MODEL
 * ---------------------------------------------------------------------------------------------------------------
 *   target = action layer (ctx.to tweens) ?? pose layer (eased blend between poses)  →  damped spring per channel
 *   → + additive layers (breathing, idle sway, gait, airborne dangle, cursor tilt, def.idle)  → 2-bone IK blend
 *   → prop counter-rotation & liquid → jiggles/parallax → face (blink, pupils, talk, variants).
 *   Walk: compass gait — stance foot sweeps linearly under the hip (no foot sliding at any speed), the swing foot
 *   lifts, the hip bob is exactly L·(1−cos θ); gait phase advances with distance, steps are fitted so the walk ends
 *   with both legs vertical. Hop: crouch → airborne arc (x only moves while airborne) → squash landing.
 *   Clock: every timing honours av.timeScale (0.25 = slow motion, 0 = freeze), including FX animations.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * 4. ACTION TIMELINES  (def.actions[name] = async (ctx, opts) => { … })
 * ---------------------------------------------------------------------------------------------------------------
 *   Actions run on top of the current pose; when they finish (or are cancelled by another play()) every override
 *   is released smoothly back to the pose. Helpers (all timings in ms, eases: linear in out inOut inQuad outQuad
 *   inOutSine outBack inBack inOutBack outElastic, or a function t→t):
 *     ctx.to(values, ms = 300, ease = 'inOut')   tween action-layer values (PartValues + virtual channels) → Promise
 *     ctx.set(values)                             same, instantly
 *     ctx.wait(ms)
 *     ctx.ik(side, target, ms = 450, ease)        drive hand 'L'|'R' to target (live-tracked every frame):
 *                                                 anchor name | [x, y] torso-local | { anchor | x,y, dx, dy, spout }
 *                                                 spout: true places the prop's spout (PROP_META) on the target.
 *                                                 null releases. The hand travels on an arc around the shoulder,
 *                                                 elbows bend outward, unreachable targets point the arm straight.
 *     ctx.reach(side, angle, ext = 1.05)          point for a straight arm raised `angle`° from hanging (90 = out, 180 = up)
 *     ctx.expression(name) / ctx.face({ eyes, brows, mouth }) / ctx.variant(set, value|null) / ctx.blink()
 *     ctx.say(ms)                                 talking mouth flap
 *     ctx.fx(name, opts)                          see FX
 *     ctx.hop({ height = 30, ms = 600, squash = 0.15, arms: null|'out'|'up' })   anticipation → arc → squash
 *     ctx.squash(amount, ms, ease)                volume-preserving body squash (negative = stretch)
 *     ctx.prop(tilt, ms, ease)                    shorthand for to({ prop: { tilt } })
 *     ctx.drain(amount, ms)                       lower the held liquid persistently (drinking)
 *     ctx.propVisible(bool, ms)                   pop the prop out/in (e.g. a pill being swallowed)
 *     ctx.front(part, bool)                       draw armL in front of the head (hand to mouth), auto-restored
 *     ctx.idle({ breath, sway })                  scale idle layers during the action (1 = normal)
 *     ctx.anchor(name) → [x, y] torso-local       ctx.base(part, ch) → pose value
 *     ctx.emit(event, data)                       av.on() listeners ('step', 'land', 'gulp', 'flash', …)
 *     ctx.def, ctx.av, ctx.opts, ctx.mood, ctx.facing, ctx.propId, ctx.propMeta, ctx.state, ctx.t, ctx.rand(a,b),
 *     ctx.cancelled
 *   Built-in actions (ACTION_LIB below) are the reference; Nova uses them unmodified.
 *
 *   def.idle(ictx, t, dt) → PartValues added this frame. ictx: { mood, walking (0..1), airborne (0..1), turn,
 *   talking, speaking, state (per-instance object), fx(name, opts), rand(a,b) }. Example (tail sway):
 *     idle: (c, t) => ({ tail: { rot: Math.sin(t * 2.2) * (c.mood === 'happy' ? 14 : 6) } })
 *
 * ---------------------------------------------------------------------------------------------------------------
 * 5. PUBLIC API  (see createAvatar)
 * ---------------------------------------------------------------------------------------------------------------
 *   av.el, av.width, av.height, av.x, av.y, av.timeScale, av.mood, av.facing, av.busy, av.def
 *   setFacing(1|-1|0) · walkTo(x, {speed, mood}) · glideTo({x, y}, {ms, ease, sway}) · pose(name, {duration})
 *   expression(name) · setMood(m) · play(name, opts) · stop() · say(ms) · lookAt(cx, cy) | lookAt(null)
 *   fx(name, opts) → {stop, done} (fx('clear') stops all) · setProp(id, emoji) · setColor(hex|null)
 *   setAvatar(id, customUrl) · setHeight(px) · anchor(name) → {x, y} host px · hitTest(cx, cy) · on(evt, cb) → off
 *   debug(bool) (draws pivots & anchors) · destroy()
 */

import { canopyDescent, canopySway } from './entrance-motion.js';
import { AVATAR_DEFS, AVATAR_ORDER } from './avatars/index.js';
import { PROPS, PROP_META, renderProp, namespaceIds } from './props.js';
import { FX, playFx } from './fx.js';
import { createAvatar3D, ME3D_INFO, KAI3D_URL } from './avatar-3d.js';

let kai3dFailed = false; // WebGL/model failure: later Kai instances go straight to the 2D rig

export { PROPS, PROP_META, FX };

const SVGNS = 'http://www.w3.org/2000/svg';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const TAU = Math.PI * 2;
const CHANNELS = ['rot', 'x', 'y', 'sx', 'sy'];
const REST = { rot: 0, x: 0, y: 0, sx: 1, sy: 1 };
const VIRTUAL = { prop: { tilt: 0 }, look: { x: 0, y: 0 }, view: { turn: 0 }, mouth: { open: 1 } };
const SPECIAL_PARTS = new Set(['pupils', 'blush', 'grip', 'water']);
const CANCEL = Symbol('nb-cancel');

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (v) => v - Math.floor(v);
const smoothstep = (v) => {
  const t = v < 0 ? 0 : v > 1 ? 1 : v;
  return t * t * (3 - 2 * t);
};
const rand = (a, b) => a + Math.random() * (b - a);

export const EASE = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  inBack: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
  inOutBack: (t) => {
    const c = 2.5949095;
    return t < 0.5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
  },
  outElastic: (t) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
const easeFn = (e) => (typeof e === 'function' ? e : EASE[e] || EASE.inOut);

// ------------------------------------------------------------------------------------------------- 2D affine math
// [a, b, c, d, e, f] — x' = a·x + c·y + e, y' = b·x + d·y + f (same as SVG matrix()).
const IDENT = [1, 0, 0, 1, 0, 0];
function mmul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function minv(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  const i = 1 / det;
  return [m[3] * i, -m[1] * i, -m[2] * i, m[0] * i, (m[2] * m[5] - m[3] * m[4]) * i, (m[1] * m[4] - m[0] * m[5]) * i];
}
const mapply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mrot = (deg) => {
  const r = deg * D2R;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
const mangle = (m) => Math.atan2(m[1], m[0]) * R2D;
// T(p + t) · R(rot) · S(sx, sy) · T(−p)
function partMatrix(px, py, rot, x, y, sx, sy) {
  const r = rot * D2R;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const a = c * sx;
  const b = s * sx;
  const cc = -s * sy;
  const d = c * sy;
  return [a, b, cc, d, px + x - (a * px + cc * py), py + y - (b * px + d * py)];
}
const mstr = (m) =>
  `matrix(${m[0].toFixed(4)} ${m[1].toFixed(4)} ${m[2].toFixed(4)} ${m[3].toFixed(4)} ${m[4].toFixed(2)} ${m[5].toFixed(2)})`;
const normDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const near = (a, ref) => ref + normDeg(a - ref);

// Damped spring, semi-implicit Euler with fixed substeps (stable for any frame time).
function stepSpring(s, target, dt) {
  const n = dt > 0.0042 ? Math.ceil(dt / 0.0042) : 1;
  const h = dt / n;
  const w = s.w;
  const z = s.z;
  let v = s.v;
  let vel = s.vel;
  for (let i = 0; i < n; i++) {
    vel += (w * w * (target - v) - 2 * z * w * vel) * h;
    v += vel * h;
  }
  s.v = v;
  s.vel = vel;
}

// Spring (ω rad/s, ζ) per channel: squash wobbles, the head follows through, the hips stay planted.
function springParams(part, ch) {
  if (part === 'body') {
    if (ch === 'sx' || ch === 'sy') return [24, 0.42];
    if (ch === 'y') return [36, 1];
    if (ch === 'x') return [22, 1];
    return [15, 0.78];
  }
  if (part === 'head') return ch === 'rot' ? [14, 0.62] : [18, 0.72];
  if (part === 'face' || part === 'torso') return [18, 0.8];
  if (part.startsWith('arm') || part.startsWith('forearm')) return [17, 0.74];
  if (part.startsWith('leg')) return [20, 0.85];
  if (part === 'look') return [32, 0.86];
  if (part === 'view') return [11, 0.92];
  if (part === 'prop') return [15, 0.68];
  if (part === 'mouth') return [24, 0.8];
  return [16, 0.78];
}

// ------------------------------------------------------------------------------------------------- shared ticker
const live = new Set();
let rafId = 0;
let lastTs = 0;
let ticking = false;
function tick(ts) {
  rafId = 0;
  const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
  lastTs = ts;
  ticking = true;
  try { for (const a of live) a._frame(dt); }
  finally { ticking = false; }
  if (live.size) rafId = requestAnimationFrame(tick);
}
function wakeTicker(a) {
  live.add(a);
  if (!rafId && !ticking) {
    lastTs = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}

function ensureStyles() {
  if (document.querySelector('link[data-nb-engine]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./fx.css', import.meta.url).href;
  link.dataset.nbEngine = '';
  document.head.appendChild(link);
}

// ------------------------------------------------------------------------------------------------- catalogs
const ACTION_INFO = [
  ['drink', 'Take a sip'],
  ['call', 'Make a call'],
  ['stretch', 'Stretch'],
  ['breathe', 'Deep breaths'],
  ['cheer', 'Cheer'],
  ['nod', 'Nod & thumbs up'],
];
/** The six "after YES" reminder actions (matches ACTION_IDS in defaults.js). */
export const ACTIONS = ACTION_INFO.map(([id, name]) => ({ id, name }));
/** Every playable move, including the reminder actions. */
export const MOVES = [
  ...ACTIONS,
  ...[
    ['wave', 'Wave'], ['jump', 'Jump'], ['yawn', 'Yawn'], ['sigh', 'Sigh'], ['giggle', 'Giggle'], ['land', 'Land'],
    ['lookAround', 'Look around'], ['dance', 'Happy dance'], ['poke', 'Poked'], ['pet', 'Petted'],
  ].map(([id, name]) => ({ id, name })),
];
export const POSE_NAMES = ['idle', 'present', 'wave', 'shrug', 'sad', 'happy', 'think', 'peek', 'umbrella'];
export const EXPRESSION_NAMES = ['neutral', 'happy', 'sad', 'surprised', 'closed', 'love'];

const CUSTOM_COLORS = { primary: '#12B5D0', secondary: '#26324D', accent: '#FF8A5B' };
export const AVATARS = [
  ME3D_INFO,
  ...AVATAR_ORDER.map((id) => {
    const d = AVATAR_DEFS[id];
    return { id, name: d.name, tagline: d.tagline, colors: { ...d.colors }, locomotion: d.locomotion || 'walk' };
  }),
  { id: 'custom', name: 'Your image', tagline: 'Your own picture, brought to life', colors: { ...CUSTOM_COLORS }, locomotion: 'hop' },
];

const DEFAULT_PIVOTS = {
  body: [100, 300], torso: [100, 236], head: [100, 152], armL: [70, 166], forearmL: [66, 199], armR: [130, 166],
  forearmR: [134, 199], legL: [88, 236], legR: [112, 236], tail: [122, 232],
};
const DEFAULT_ANCHORS = {
  top: [100, 24], mouth: [100, 128], earR: [152, 104], earL: [48, 104], chest: [100, 190], handL: [64, 230],
  handR: [136, 230], eyeL: [80, 100], eyeR: [120, 100], ground: [100, 300],
};
const ANCHOR_PARENTS = {
  top: 'head', earL: 'head', earR: 'head', mouth: 'face', eyeL: 'face', eyeR: 'face', chest: 'torso',
  handL: 'forearmL', handR: 'forearmR', ground: 'body',
};
const PART_FALLBACK = { face: 'head', head: 'torso', forearmL: 'armL', forearmR: 'armR', armL: 'torso', armR: 'torso', torso: 'body' };

const TUNING = { faceTurn: 7, pupil: [4.2, 3.4], walkSpeed: 1, stride: 1, lift: 1, hopHeight: 1, hopLength: 1, breath: 1, sway: 1, armSwing: 1, propScale: 1 };

const MOOD = {
  neutral: { speed: 1, stride: 21, lift: 7, lean: 3.2, bounce: 0, arm: 1, breathHz: 0.24, breath: 1, hopDur: 0.5, hopH: 26, expr: 'neutral' },
  happy: { speed: 1.16, stride: 23, lift: 9, lean: 4, bounce: 3.4, arm: 1.25, breathHz: 0.3, breath: 1.1, hopDur: 0.42, hopH: 34, expr: 'happy' },
  sad: { speed: 0.6, stride: 14, lift: 4, lean: 1.2, bounce: 0, arm: 0.4, breathHz: 0.17, breath: 0.85, hopDur: 0.68, hopH: 12, expr: 'sad' },
};

const EXPRESSIONS = {
  neutral: { eyes: 'open', brows: 'neutral', mouth: 'smile', blush: 0 },
  happy: { eyes: 'happy', brows: 'raised', mouth: 'grin', blush: 0.3 },
  sad: { eyes: 'sad', brows: 'sad', mouth: 'sad', blush: 0 },
  surprised: { eyes: 'open', brows: 'raised', mouth: 'o', blush: 0, eyeScale: 1.1 },
  closed: { eyes: 'closed', brows: 'neutral', mouth: 'smile', blush: 0 },
  love: { eyes: 'love', brows: 'raised', mouth: 'grin', blush: 0.9 },
};
const VARIANT_FALLBACK = {
  'eyes:love': 'happy', 'eyes:wink': 'happy', 'eyes:sleepy': 'closed', 'eyes:happy': 'closed', 'eyes:closed': 'happy',
  'eyes:sad': 'open', 'mouth:grin': 'smile', 'mouth:flat': 'smile', 'mouth:sad': 'flat', 'mouth:o': 'grin',
  'brows:raised': 'neutral', 'brows:sad': 'neutral', 'handL:thumb': 'open',
};

// ------------------------------------------------------------------------------------------------- poses
const POSES = {
  idle: { armL: { rot: 4 }, forearmL: { rot: -7 }, armR: { rot: -4 }, forearmR: { rot: 9 } },
  // The reel pose: prop held up proudly beside the chest, slight head tilt.
  present: {
    head: { rot: 4.5 }, torso: { rot: -1.2 }, armL: { rot: 7 }, forearmL: { rot: -12 },
    prop: { tilt: 6 }, view: { turn: 0.1 }, ik: { R: [151, 186] },
  },
  wave: { armL: { rot: 118 }, forearmL: { rot: 36 }, armR: { rot: -4 }, forearmR: { rot: 9 }, head: { rot: -4 }, variants: { handL: 'open' } },
  shrug: {
    armL: { rot: 32, y: -3 }, forearmL: { rot: 64 }, armR: { rot: -32, y: -3 }, forearmR: { rot: -64 },
    head: { rot: 7, y: 1.5 }, torso: { sy: 1.015 }, faceSets: { brows: 'raised', mouth: 'flat' },
  },
  sad: {
    torso: { rot: 1.5, sy: 0.972 }, head: { rot: 7, y: 5 }, face: { y: 3.2, sy: 0.97 },
    armL: { rot: -1 }, forearmL: { rot: -2 }, armR: { rot: 2 }, forearmR: { rot: 2 },
    prop: { tilt: 18 }, look: { y: 0.55 }, expression: 'sad',
  },
  happy: {
    torso: { sy: 1.012 }, head: { rot: -4 }, armL: { rot: 24 }, forearmL: { rot: -28 }, armR: { rot: -22 }, forearmR: { rot: 26 },
    expression: 'happy',
  },
  think: {
    head: { rot: -6 }, torso: { rot: 1 }, ik: { L: { anchor: 'mouth', dx: -5, dy: 13 } }, front: ['armL'],
    look: { x: 0.55, y: -0.65 }, faceSets: { mouth: 'flat', brows: 'raised' },
  },
  peek: {
    mirror: true, body: { rot: 8 }, head: { rot: 9 }, view: { turn: 0.45 },
    armL: { rot: 16 }, forearmL: { rot: -38 }, armR: { rot: -16 }, forearmR: { rot: 38 }, faceSets: { brows: 'raised' },
  },
  umbrella: {
    propOverride: 'umbrella', ik: { R: [146, 120] }, prop: { tilt: -16 }, armL: { rot: 36 }, forearmL: { rot: -22 },
    head: { rot: -3 }, look: { y: -0.25 },
  },
};

// ------------------------------------------------------------------------------------------------- actions
const ACTION_LIB = {
  async drink(c) {
    const meta = c.propMeta;
    const tilt = meta.drinkTilt ?? -100;
    const liquid = !!meta.water;
    c.idle({ sway: 0.3 });
    c.face({ mouth: 'o' });
    // anticipation: a tiny dip before the lift
    await c.to({ body: { sy: 0.975, sx: 1.012 }, head: { rot: 3 }, armR: { rot: -8 }, forearmR: { rot: 16 } }, 170, 'out');
    c.to({ body: { sy: 1.01, sx: 0.996 } }, 320, 'out');
    c.to({ prop: { tilt: tilt * 0.25 } }, 360, 'inOut');
    c.ik('R', { anchor: 'mouth', spout: true, dx: 0.5, dy: 0.5 }, 640, 'inOut');
    await c.wait(300);
    c.to({ prop: { tilt }, head: { rot: -7, y: -1 }, face: { y: -1.4 }, view: { turn: 0.24 }, look: { x: 0.3, y: -0.3 } }, 440, 'inOut');
    await c.wait(380);
    c.face({ eyes: 'closed', mouth: 'o' });
    if (meta.consumable) {
      c.propVisible(false, 140);
      await c.wait(180);
    }
    for (let i = 0; i < (meta.consumable ? 1 : 3); i++) {
      c.emit('gulp', i);
      if (liquid) c.drain(0.075, 260);
      await c.to({ head: { rot: -9.5, y: 0.8 }, torso: { sy: 0.99 }, body: { sy: 0.994 } }, 170, 'out');
      await c.to({ head: { rot: -7, y: -1 }, torso: { sy: 1.004 }, body: { sy: 1.004 } }, 240, 'inOut');
    }
    await c.wait(140);
    c.ik('R', null, 580, 'inOut');
    c.to({ prop: { tilt: 0 }, head: { rot: 2, y: 0 }, face: { y: 0 }, view: { turn: 0 }, look: { x: 0, y: 0 } }, 520, 'inOut');
    await c.wait(360);
    if (meta.consumable) c.propVisible(true, 260);
    // satisfied "ahh"
    c.face({ eyes: 'happy', mouth: 'grin' });
    await c.to({ body: { sy: 1.035, sx: 0.985 }, head: { rot: -3, y: -1.5 }, armL: { rot: 14 }, forearmL: { rot: -22 } }, 280, 'out');
    await c.wait(560);
  },

  async call(c) {
    c.face({ mouth: 'smile' });
    await c.to({ body: { sy: 0.98 }, head: { rot: -2 } }, 140, 'out');
    c.ik('R', { anchor: 'earR', dx: 1, dy: 13 }, 620, 'inOut');
    c.to({ body: { sy: 1 }, prop: { tilt: -14 }, head: { rot: 9 }, view: { turn: -0.12 }, look: { x: -0.45, y: -0.3 } }, 620, 'inOut');
    await c.wait(640);
    c.face({ brows: 'raised' });
    c.say(2600);
    for (let i = 0; i < 3; i++) {
      await c.to({ head: { rot: 11.5, y: 1.4 }, face: { y: 1 }, armL: { rot: 14 }, forearmL: { rot: -46 } }, 270, 'inOut');
      await c.to({ head: { rot: 8, y: -0.4 }, face: { y: -0.3 }, armL: { rot: 8 }, forearmL: { rot: -14 } }, 300, 'inOut');
      await c.wait(i === 1 ? 260 : 80);
    }
    c.face({ eyes: 'happy', mouth: 'grin', brows: 'raised' });
    await c.wait(520);
    c.ik('R', null, 540, 'inOut');
    await c.to({ prop: { tilt: 0 }, head: { rot: 0, y: 0 }, face: { y: 0 }, view: { turn: 0 }, look: { x: 0, y: 0 }, armL: { rot: 4 }, forearmL: { rot: -7 } }, 540, 'inOut');
  },

  async stretch(c) {
    c.idle({ sway: 0 });
    c.face({ eyes: 'closed', mouth: 'o' });
    c.variant('handL', 'open');
    await c.to({ body: { sy: 0.97, sx: 1.01 }, armL: { rot: -6 }, armR: { rot: 6 } }, 220, 'out');
    c.ik('L', c.reach('L', 143), 720, 'inOut');
    c.ik('R', c.reach('R', 143), 720, 'inOut');
    await c.to({ body: { sy: 1.05, sx: 0.976 }, head: { y: -2 }, torso: { sy: 1.02 } }, 720, 'inOut');
    await c.wait(260);
    await c.to({ body: { rot: -7 }, torso: { rot: -5 }, head: { rot: -6 } }, 680, 'inOut');
    await c.wait(220);
    await c.to({ body: { rot: 7 }, torso: { rot: 5 }, head: { rot: 6 } }, 940, 'inOut');
    await c.wait(220);
    await c.to({ body: { rot: 0, sy: 1.02 }, torso: { rot: 0, sy: 1 }, head: { rot: 0, y: 0 } }, 520, 'inOut');
    c.ik('L', null, 620, 'inOut');
    c.ik('R', null, 620, 'inOut');
    c.face({ eyes: 'happy', mouth: 'grin' });
    await c.to({ body: { sy: 0.975, sx: 1.012 } }, 320, 'out');
    await c.to({ body: { sy: 1, sx: 1 } }, 320, 'outBack');
    await c.wait(280);
  },

  async breathe(c) {
    c.idle({ breath: 0, sway: 0.25 });
    c.face({ eyes: 'closed', mouth: 'smile' });
    await c.to({ armL: { rot: 9 }, forearmL: { rot: -14 }, armR: { rot: -9 }, forearmR: { rot: 14 } }, 400, 'inOut');
    for (let i = 0; i < 3; i++) {
      c.face({ mouth: 'smile' });
      await c.to({
        torso: { sy: 1.045, sx: 1.012 }, head: { y: -2.6 }, armL: { y: -2.4, rot: 13 }, armR: { y: -2.4, rot: -13 }, body: { sy: 1.008 },
      }, 1500, 'inOutSine');
      await c.wait(260);
      c.face({ mouth: 'o' });
      c.to({ mouth: { open: 0.7 } }, 300);
      c.fx('puff', { anchor: 'mouth', dir: i % 2 ? -1 : 1 });
      await c.to({
        torso: { sy: 0.99, sx: 1 }, head: { y: 0.6 }, armL: { y: 0.4, rot: 8 }, armR: { y: 0.4, rot: -8 }, body: { sy: 1 },
      }, 1700, 'inOutSine');
      c.to({ mouth: { open: 1 } }, 200);
      await c.wait(160);
    }
    c.face({ eyes: 'happy', mouth: 'grin' });
    await c.wait(520);
  },

  async cheer(c) {
    c.face({ eyes: 'happy', mouth: 'grin', brows: 'raised' });
    await c.to({ body: { sy: 0.86, sx: 1.08 }, armL: { rot: -10 }, armR: { rot: 10 }, head: { y: 2 } }, 210, 'out');
    c.to({ armL: { rot: 152 }, forearmL: { rot: 14 }, armR: { rot: -152 }, forearmR: { rot: -14 }, head: { y: -1 } }, 230, 'out');
    c.emit('hop');
    c.to({ body: { sy: 1.1, sx: 0.94 } }, 150, 'out');
    await c.to({ body: { y: -42 } }, 270, 'outQuad');
    c.to({ body: { sy: 1.02, sx: 1 } }, 200, 'inOut');
    await c.to({ body: { y: 0 } }, 250, 'inQuad');
    c.emit('land');
    await c.to({ body: { sy: 0.84, sx: 1.1 }, head: { y: 2.5 } }, 90, 'out');
    c.to({ armL: { rot: 128 }, armR: { rot: -128 }, head: { y: 0 } }, 300, 'out');
    await c.to({ body: { sy: 1.03, sx: 0.986 } }, 180, 'out');
    await c.hop({ height: 13, ms: 400, squash: 0.08 });
    await c.wait(260);
  },

  async nod(c) {
    c.face({ mouth: 'smile' });
    for (let i = 0; i < 2; i++) {
      await c.to({ head: { y: 2.8, rot: 1.5, sy: 0.985 }, face: { y: 3.4 }, look: { y: 0.3 } }, 170, 'inOut');
      await c.to({ head: { y: -0.6, rot: 0, sy: 1 }, face: { y: -0.8 }, look: { y: -0.1 } }, 210, 'inOut');
    }
    c.to({ head: { y: 0 }, face: { y: 0 }, look: { y: 0 } }, 200);
    c.variant('handL', 'thumb');
    c.ik('L', [54, 184], 380, 'outBack');
    c.face({ eyes: 'wink', mouth: 'grin' });
    await c.to({ head: { rot: -5 }, view: { turn: -0.1 } }, 320, 'out');
    await c.wait(120);
    c.fx('sparkles', { count: 3, anchor: 'handL', spread: 0.35 });
    await c.to({ forearmL: { sy: 1 }, body: { sy: 1.015 } }, 160, 'out');
    await c.wait(700);
    c.ik('L', null, 460, 'inOut');
    await c.to({ head: { rot: 0 }, view: { turn: 0 } }, 300);
    c.variant('handL', null);
  },

  async wave(c) {
    c.face({ eyes: 'happy', mouth: 'grin' });
    c.variant('handL', 'open');
    await c.to({ armL: { rot: 116 }, forearmL: { rot: 36 }, head: { rot: -4 }, view: { turn: -0.08 } }, 380, 'outBack');
    for (let i = 0; i < 3; i++) {
      await c.to({ forearmL: { rot: 58 } }, 170, 'inOut');
      await c.to({ forearmL: { rot: 18 } }, 170, 'inOut');
    }
    await c.to({ forearmL: { rot: 36 } }, 160);
    await c.wait(140);
  },

  async jump(c) {
    c.face({ eyes: 'open', brows: 'raised', mouth: 'o' });
    await c.hop({ height: 32, ms: 580, squash: 0.15, arms: 'out' });
    await c.wait(120);
  },

  async yawn(c) {
    c.idle({ breath: 0 });
    c.face({ eyes: 'closed', brows: 'sad', mouth: 'o' });
    c.front('armL', true);
    c.variant('handL', 'open');
    c.to({ mouth: { open: 1.7 } }, 720, 'inOut');
    c.ik('L', { anchor: 'mouth', dx: -1, dy: 6 }, 620, 'inOut');
    await c.to({ head: { rot: -6, y: -2 }, face: { y: -1 }, torso: { sy: 1.035 }, body: { sy: 1.01 } }, 820, 'inOut');
    await c.wait(700);
    c.to({ mouth: { open: 0.5 } }, 360, 'inOut');
    c.ik('L', null, 520, 'inOut');
    await c.to({ head: { rot: 3, y: 1 }, face: { y: 0.6 }, torso: { sy: 0.99 }, body: { sy: 1 } }, 520, 'inOut');
    c.face({ eyes: 'sleepy', mouth: 'flat' });
    await c.wait(380);
    c.blink();
    await c.wait(420);
  },

  async sigh(c) {
    c.idle({ breath: 0 });
    c.face({ eyes: 'sad', brows: 'sad', mouth: 'flat' });
    await c.to({ torso: { sy: 1.035 }, head: { y: -2.2, rot: -2 }, armL: { y: -2.5 }, armR: { y: -2.5 } }, 640, 'inOut');
    c.face({ eyes: 'closed', mouth: 'o' });
    c.fx('puff', { anchor: 'mouth', dir: c.facing || 1 });
    await c.to({
      torso: { sy: 0.955, rot: 1.5 }, head: { y: 4, rot: 7 }, face: { y: 2.5 }, armL: { y: 1.5, rot: 0 }, armR: { y: 1.5, rot: 0 }, body: { sy: 0.985 },
    }, 920, 'inOutSine');
    c.face({ eyes: 'sad', mouth: 'sad' });
    await c.wait(520);
  },

  async giggle(c) {
    c.face({ eyes: 'happy', mouth: 'grin' });
    c.fx('blush', { duration: 1200 });
    c.front('armL', true);
    c.variant('handL', 'open');
    c.ik('L', { anchor: 'mouth', dx: -2, dy: 7 }, 300, 'out');
    await c.wait(200);
    for (let i = 0; i < 7; i++) {
      await c.to({ torso: { rot: 2.4 }, head: { rot: -3, y: -1.2 }, body: { sy: 1.012 } }, 70, 'inOut');
      await c.to({ torso: { rot: -1.6 }, head: { rot: 2, y: 0.4 }, body: { sy: 0.99 } }, 70, 'inOut');
    }
    c.ik('L', null, 360, 'inOut');
    await c.to({ torso: { rot: 0 }, head: { rot: 0, y: 0 }, body: { sy: 1 } }, 260);
    await c.wait(160);
  },

  async land(c) {
    c.face({ eyes: 'closed', mouth: 'o' });
    c.emit('land');
    // Knees absorb the impact on jointed legs; the umbrella hand stays overhead until it is thrown.
    const kn = c.knees;
    const armR = (rot, fore) => (c.opts.umbrella ? {} : { armR: { rot }, ...(fore === undefined ? {} : { forearmR: { rot: fore } }) });
    await c.to({ body: kn ? { sy: 0.96, sx: 1.02, y: 5 } : { sy: 0.78, sx: 1.14 }, armL: { rot: 55 }, forearmL: { rot: -20 }, ...armR(-55, 20), head: { y: 3 } }, 95, 'out');
    c.face({ eyes: 'open', mouth: 'grin' });
    await c.to({ body: kn ? { sy: 1.02, sx: 0.99, y: -1 } : { sy: 1.06, sx: 0.97 }, armL: { rot: 22 }, ...armR(-22), head: { y: -1 } }, 210, 'out');
    await c.to({ body: { sy: 1, sx: 1, y: 0 }, armL: { rot: 4 }, forearmL: { rot: -7 }, ...armR(-4, 9), head: { y: 0 } }, 280, 'inOut');
  },

  // Ballistic umbrella throw after a drop entrance: wind-up, release with the hand's velocity, the canopy flies off
  // under gravity while spinning, and the reminder prop is revealed from the hip after the follow-through.
  async throwUmbrella(c) {
    if (c.propId !== 'umbrella') return;
    const dir = c.opts.dir || 1;
    c.face({ eyes: 'open', brows: 'raised', mouth: 'grin' });
    await c.to({ torso: { rot: -dir * 4 }, head: { rot: dir * 3 }, prop: { tilt: -dir * 26 }, view: { turn: dir * 0.12 } }, 200, 'inOut');
    c.ik('R', [100 - dir * 26, 96], 200, 'inOut');
    await c.wait(200);
    c.ik('R', [100 + dir * 58, 62], 170, 'in');
    c.to({ torso: { rot: dir * 5 }, head: { rot: -dir * 2 }, prop: { tilt: dir * 34 } }, 170, 'in');
    await c.wait(150);
    c.toss({ vx: dir * 1.15, vy: -1.25, spin: dir * 430 });
    c.emit('release', { dir });
    c.ik('R', [100 + dir * 30, 214], 300, 'out');
    await c.to({ torso: { rot: dir * 2 }, head: { rot: 0 }, prop: { tilt: 0 }, view: { turn: 0 } }, 300, 'out');
    c.ik('R', null, 380, 'inOut');
    await c.to({ torso: { rot: 0 } }, 200, 'inOut');
    c.propVisible(true, 260);
    c.face({ eyes: 'happy', mouth: 'smile' });
    await c.wait(220);
  },

  async lookAround(c) {
    c.face({ brows: 'raised' });
    await c.to({ view: { turn: -0.75 }, look: { x: -0.9, y: -0.1 }, head: { rot: -5 }, body: { rot: -1 } }, 400, 'inOut');
    await c.wait(520);
    c.blink();
    await c.to({ view: { turn: 0.75 }, look: { x: 0.9, y: -0.05 }, head: { rot: 5 }, body: { rot: 1 } }, 560, 'inOut');
    await c.wait(560);
    await c.to({ view: { turn: 0 }, look: { x: 0, y: 0 }, head: { rot: 0 }, body: { rot: 0 } }, 400, 'inOut');
    c.blink();
    await c.wait(200);
  },

  async dance(c) {
    c.face({ eyes: 'happy', mouth: 'grin' });
    c.fx('notes');
    for (let i = 0; i < 4; i++) {
      const s = i % 2 ? 1 : -1;
      await c.to({
        body: { rot: 6 * s, sy: 0.96 }, head: { rot: -9 * s }, view: { turn: 0.3 * s },
        armL: { rot: s > 0 ? 120 : 36 }, forearmL: { rot: s > 0 ? 30 : -40 },
        armR: { rot: s > 0 ? -36 : -120 }, forearmR: { rot: s > 0 ? 40 : -30 },
      }, 240, 'inOut');
      c.emit('step', { foot: s > 0 ? 'R' : 'L' });
      await c.to({ body: { sy: 1.03 } }, 150, 'out');
    }
    await c.to({ body: { rot: 0, sy: 1 }, head: { rot: 0 }, view: { turn: 0 } }, 260);
  },

  async poke(c) {
    c.face({ eyes: 'open', brows: 'raised', mouth: 'o' });
    c.fx('exclaim');
    await c.to({ body: { sy: 0.9, sx: 1.06 }, head: { y: 2 } }, 70, 'out');
    await c.hop({ height: 22, ms: 470, squash: 0.12, arms: 'out' });
    c.face({ eyes: 'happy', mouth: 'grin' });
    await c.to({ head: { rot: -6 } }, 160, 'out');
    for (let i = 0; i < 3; i++) {
      await c.to({ torso: { rot: 2 }, head: { y: -1 } }, 70);
      await c.to({ torso: { rot: -1.5 }, head: { y: 0.5 } }, 70);
    }
    await c.wait(150);
  },

  async pet(c) {
    c.face({ eyes: 'happy', mouth: 'grin' });
    c.fx('blush', { duration: 1500 });
    for (let i = 0; i < 2; i++) {
      await c.to({ head: { rot: 8 }, body: { rot: 2 }, view: { turn: 0.2 } }, 320, 'inOut');
      await c.to({ head: { rot: -6 }, body: { rot: -1.5 }, view: { turn: -0.15 } }, 360, 'inOut');
    }
    await c.to({ head: { rot: 0 }, body: { rot: 0 }, view: { turn: 0 } }, 260);
  },
};

// ------------------------------------------------------------------------------------------------- custom image rig
// A picture becomes a "sprite" buddy: hop locomotion, squash & stretch, tilt, floating prop at handR.
const CUSTOM_ACTIONS = {
  async drink(c) {
    const meta = c.propMeta;
    const m = c.anchor('mouth');
    const h = c.anchor('handR');
    const tilt = meta.drinkTilt ?? -100;
    const r = tilt * D2R;
    const [sx, sy] = meta.spout;
    const off = [sx * Math.cos(r) - sy * Math.sin(r), sx * Math.sin(r) + sy * Math.cos(r)];
    await c.to({ sprite: { sy: 0.95, sx: 1.03 } }, 150, 'out');
    c.to({ sprite: { sy: 1, sx: 1, rot: -5 } }, 420, 'inOut');
    await c.to({ forearmR: { x: m[0] - h[0] - off[0], y: m[1] - h[1] - off[1] }, prop: { tilt } }, 620, 'inOut');
    for (let i = 0; i < 3; i++) {
      c.emit('gulp', i);
      if (meta.water) c.drain(0.075, 240);
      await c.to({ sprite: { sy: 0.97, rot: -7 } }, 160, 'out');
      await c.to({ sprite: { sy: 1, rot: -5 } }, 220, 'inOut');
    }
    await c.to({ forearmR: { x: 0, y: 0 }, prop: { tilt: 0 }, sprite: { rot: 0 } }, 540, 'inOut');
    await c.hop({ height: 16, ms: 440, squash: 0.1 });
  },
  async call(c) {
    const e = c.anchor('earR');
    const h = c.anchor('handR');
    await c.to({ forearmR: { x: e[0] - h[0] + 4, y: e[1] - h[1] + 14 }, prop: { tilt: -14 }, sprite: { rot: 4 } }, 600, 'inOut');
    c.say(2400);
    for (let i = 0; i < 4; i++) {
      await c.to({ sprite: { rot: 7, sy: 0.985 } }, 260, 'inOut');
      await c.to({ sprite: { rot: 3, sy: 1 } }, 280, 'inOut');
    }
    await c.to({ forearmR: { x: 0, y: 0 }, prop: { tilt: 0 }, sprite: { rot: 0 } }, 520, 'inOut');
  },
  async stretch(c) {
    await c.to({ sprite: { sy: 0.94, sx: 1.04 } }, 200, 'out');
    await c.to({ sprite: { sy: 1.12, sx: 0.93 } }, 700, 'inOut');
    await c.to({ sprite: { rot: -8 } }, 640, 'inOut');
    await c.to({ sprite: { rot: 8 } }, 900, 'inOut');
    await c.to({ sprite: { rot: 0, sy: 1, sx: 1 } }, 520, 'outBack');
  },
  async breathe(c) {
    for (let i = 0; i < 3; i++) {
      await c.to({ sprite: { sy: 1.045, sx: 1.015 } }, 1500, 'inOutSine');
      c.fx('puff', { anchor: 'mouth', dir: i % 2 ? -1 : 1 });
      await c.to({ sprite: { sy: 0.99, sx: 1 } }, 1700, 'inOutSine');
    }
  },
  async cheer(c) {
    await c.to({ body: { sy: 0.86, sx: 1.08 } }, 200, 'out');
    c.to({ body: { sy: 1.1, sx: 0.94 } }, 150, 'out');
    c.to({ sprite: { sx: -1 } }, 260, 'inOut').then(() => c.to({ sprite: { sx: 1 } }, 260, 'inOut'));
    await c.to({ body: { y: -44 } }, 270, 'outQuad');
    c.to({ body: { sy: 1, sx: 1 } }, 200);
    await c.to({ body: { y: 0 } }, 250, 'inQuad');
    c.emit('land');
    await c.to({ body: { sy: 0.84, sx: 1.1 } }, 90, 'out');
    await c.to({ body: { sy: 1, sx: 1 } }, 260, 'outBack');
    await c.hop({ height: 12, ms: 400, squash: 0.08 });
  },
  async nod(c) {
    for (let i = 0; i < 2; i++) {
      await c.to({ sprite: { sy: 0.95, rot: 2 } }, 170, 'inOut');
      await c.to({ sprite: { sy: 1.01, rot: 0 } }, 210, 'inOut');
    }
    c.fx('sparkles', { count: 4, anchor: 'top', spread: 0.6 });
    await c.to({ sprite: { sy: 1 } }, 300);
  },
  async wave(c) {
    for (let i = 0; i < 3; i++) {
      await c.to({ sprite: { rot: -6 }, forearmR: { y: -14 } }, 180, 'inOut');
      await c.to({ sprite: { rot: 6 }, forearmR: { y: -6 } }, 180, 'inOut');
    }
    await c.to({ sprite: { rot: 0 }, forearmR: { y: 0 } }, 200);
  },
  async sigh(c) {
    await c.to({ sprite: { sy: 1.03 } }, 600, 'inOut');
    c.fx('puff', { anchor: 'mouth', dir: c.facing || 1 });
    await c.to({ sprite: { sy: 0.94, rot: 4 } }, 900, 'inOutSine');
    await c.wait(400);
  },
  async giggle(c) {
    c.fx('blush', { duration: 1000 });
    for (let i = 0; i < 7; i++) {
      await c.to({ sprite: { rot: 3, sy: 1.015 } }, 70);
      await c.to({ sprite: { rot: -3, sy: 0.99 } }, 70);
    }
    await c.to({ sprite: { rot: 0, sy: 1 } }, 200);
  },
  async yawn(c) {
    await c.to({ sprite: { sy: 1.07, sx: 0.96, rot: -3 } }, 900, 'inOut');
    await c.wait(500);
    await c.to({ sprite: { sy: 0.98, sx: 1, rot: 2 } }, 600, 'inOut');
  },
  async lookAround(c) {
    await c.to({ sprite: { rot: -6, sx: 0.97 } }, 420, 'inOut');
    await c.wait(500);
    await c.to({ sprite: { rot: 6 } }, 560, 'inOut');
    await c.wait(500);
    await c.to({ sprite: { rot: 0, sx: 1 } }, 400, 'inOut');
  },
  async pet(c) {
    c.fx('blush', { duration: 1400 });
    for (let i = 0; i < 2; i++) {
      await c.to({ sprite: { rot: 7, sy: 0.98 } }, 320, 'inOut');
      await c.to({ sprite: { rot: -6, sy: 1 } }, 360, 'inOut');
    }
    await c.to({ sprite: { rot: 0 } }, 260);
  },
};

function customDef(url) {
  return {
    id: 'custom',
    name: 'Your image',
    tagline: 'Your own picture, brought to life',
    locomotion: 'hop',
    colors: { ...CUSTOM_COLORS },
    pivots: { body: [100, 300], torso: [100, 300], sprite: [100, 300], armR: [150, 214], forearmR: [150, 214] },
    anchors: {
      top: [100, 30], mouth: [100, 120], earR: [150, 96], earL: [50, 96], chest: [100, 190], handL: [44, 214],
      handR: [160, 214], eyeL: [84, 100], eyeR: [116, 100], ground: [100, 300],
    },
    anchorParents: { top: 'torso', mouth: 'torso', earR: 'torso', earL: 'torso', eyeL: 'torso', eyeR: 'torso', handL: 'torso' },
    svg: `<g data-part="body"><g data-part="torso"><g data-part="sprite" class="nb-sprite"><image data-custom-image x="0" y="0" width="200" height="300" preserveAspectRatio="xMidYMax meet"/></g>` +
      `<g data-part="armR"><g data-part="forearmR"><g data-slot="prop"/></g></g></g></g>`,
    poses: {
      present: { ik: { R: null }, forearmR: { x: -4, y: -22 }, prop: { tilt: 8 }, sprite: { rot: 3 } },
      sad: { sprite: { sy: 0.95, rot: 4 }, forearmR: { y: 8 }, prop: { tilt: 18 } },
      happy: { sprite: { sy: 1.02 } },
      shrug: { sprite: { sy: 0.97, rot: 5 } },
      think: { ik: { L: null }, front: [], sprite: { rot: -4 } },
      peek: { sprite: { rot: 8 } },
      umbrella: { ik: { R: null }, forearmR: { x: -40, y: -96 }, prop: { tilt: -10 } },
    },
    actions: CUSTOM_ACTIONS,
    idle: (c, t) => ({ forearmR: { y: Math.sin(t * 2.1) * 2.2, rot: Math.sin(t * 1.3) * 2.5 } }),
    onExpression(c, name) {
      const el = c.svg.querySelector('.nb-sprite');
      if (!el) return;
      el.classList.toggle('is-sad', name === 'sad');
      el.classList.toggle('is-happy', name === 'happy' || name === 'love');
    },
    tuning: { hopHeight: 1.1 },
  };
}

/** Avatar definition by id ('custom' needs a URL). Unknown ids fall back to the first registered avatar. */
export function getAvatarDef(id, customUrl) {
  if (id === 'custom' && customUrl) return customDef(customUrl);
  return AVATAR_DEFS[id] || AVATAR_DEFS[AVATAR_ORDER[0]];
}

// ------------------------------------------------------------------------------------------------- the avatar
let instanceSeq = 0;

class Avatar {
  constructor(host, opts = {}) {
    if (!host) throw new Error('createAvatar: host element required');
    ensureStyles();
    this.host = host;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this._suffix = `__nb${++instanceSeq}`;
    this._ts = opts.timeScale ?? 1;
    this._clock = 0;
    this._height = opts.height || 250;
    this._x = opts.x ?? 0;
    this._y = 0;
    this._mood = MOOD[opts.mood] ? opts.mood : 'neutral';
    this._facing = 0;
    this._listeners = new Map();
    this._timers = [];
    this._anims = new Set();
    this._fxHandles = new Set();
    this._destroyed = false;
    this._color = null;

    this.el = document.createElement('div');
    this.el.className = 'nb-avatar';
    Object.assign(this.el.style, { position: 'absolute', left: '0px', bottom: '0px', overflow: 'visible', pointerEvents: 'none' });
    this._svg = document.createElementNS(SVGNS, 'svg');
    this._svg.setAttribute('viewBox', '0 0 200 300');
    this._svg.setAttribute('overflow', 'visible');
    this._svg.setAttribute('aria-hidden', 'true');
    this._fxLocal = document.createElement('div');
    this._fxLocal.className = 'nb-fx-layer';
    this.el.append(this._svg, this._fxLocal);
    this._fxWorld = document.createElement('div');
    this._fxWorld.className = 'nb-fx-layer nb-fx-world';
    host.append(this.el, this._fxWorld);

    this._hostH = host.clientHeight;
    this._hostW = host.clientWidth;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        this._hostH = host.clientHeight;
        this._hostW = host.clientWidth;
        this._writeEl();
        this._wake();
      });
      this._ro.observe(host);
    }

    this._fxCtx = this._makeFxCtx();
    this._propId = 'none';
    this._propSeqN = 0;
    this._applySize();
    this._build(opts.avatarId || 'nova', opts.customUrl || null);
  }

  // ---------------------------------------------------------------------------------------------- building
  _build(avatarId, customUrl) {
    const def = getAvatarDef(avatarId, customUrl);
    this._def = def;
    this._avatarId = def.id;
    this._tune = { ...TUNING, ...(def.tuning || {}) };
    this._pivots = { ...DEFAULT_PIVOTS, ...(def.pivots || {}) };
    this._anchors = { ...DEFAULT_ANCHORS, ...(def.anchors || {}) };
    this._anchorParents = { ...ANCHOR_PARENTS, ...(def.anchorParents || {}) };
    this._state = {};

    const shadowId = `nb-shadow${this._suffix}`;
    this._svg.innerHTML =
      `<defs><radialGradient id="${shadowId}"><stop offset="0" stop-color="#0B1426" stop-opacity="0.34"/>` +
      `<stop offset="0.55" stop-color="#0B1426" stop-opacity="0.16"/><stop offset="1" stop-color="#0B1426" stop-opacity="0"/></radialGradient></defs>` +
      `<g class="nb-shadow"><ellipse cx="100" cy="299" rx="50" ry="7.5" fill="url(#${shadowId})"/>` +
      `<ellipse cx="100" cy="299.5" rx="30" ry="3.6" fill="#0B1426" opacity="0.14"/></g>` +
      namespaceIds(def.svg, this._suffix);
    this._shadow = this._svg.querySelector('.nb-shadow');
    this._shadowStr = '';

    if (def.id === 'custom') {
      const img = this._svg.querySelector('[data-custom-image]');
      img.setAttribute('href', customUrl);
      this._loadCustomBox(customUrl);
    }
    this._parseRig();
    this._setColors();
    this._propOverride = null;
    this._propVisible = 1;
    this._propVisAnim = null;
    this._initChannels();
    this._mountProp(this._propId);
  }

  _parseRig() {
    const svg = this._svg;
    this._parts = [];
    this._partIdx = {};
    for (const el of svg.querySelectorAll('[data-part]')) {
      const name = el.dataset.part;
      if (SPECIAL_PARTS.has(name) || this._partIdx[name] !== undefined) continue;
      let pv = this._pivots[name];
      if (!pv && name === 'face') pv = this._faceCenter();
      if (!pv) pv = this._bboxCenter(el);
      if (!pv) continue;
      this._partIdx[name] = this._parts.length;
      this._parts.push({ name, el, px: pv[0], py: pv[1], parent: -1, m: IDENT, w: IDENT, str: '' });
    }
    for (const p of this._parts) {
      let n = p.el.parentElement;
      while (n && n !== svg) {
        if (n.dataset && n.dataset.part && this._partIdx[n.dataset.part] !== undefined && this._parts[this._partIdx[n.dataset.part]].el === n) {
          p.parent = this._partIdx[n.dataset.part];
          break;
        }
        n = n.parentElement;
      }
    }
    // armL/armR descendants need recomputation after IK.
    for (const p of this._parts) {
      let q = p;
      p.underArm = null;
      while (q) {
        if (q.name === 'armL' || q.name === 'armR') p.underArm = q.name;
        q = q.parent >= 0 ? this._parts[q.parent] : null;
      }
    }
    this._torsoI = this._partIdx.torso ?? -1;

    this._variants = {};
    this._fades = [];
    for (const el of svg.querySelectorAll('[data-variant]')) {
      const [set, value] = el.dataset.variant.split(':');
      if (!set || !value) continue;
      const f = { el, v: 0, to: 0, str: '0', set };
      el.style.opacity = '0';
      ((this._variants[set] ||= {})[value] ||= []).push(f);
      this._fades.push(f);
    }
    this._shown = {};
    this._eyeEls = [];
    for (const [value, fs] of Object.entries(this._variants.eyes || {})) {
      if (value !== 'happy' && value !== 'closed') this._eyeEls.push(...fs.map((f) => f.el));
    }
    this._eyeStr = '';
    this._mouthO = ((this._variants.mouth && this._variants.mouth.o) || []).map((f) => f.el);
    this._mouthOStr = '';
    this._mouthOC = null;
    this._pupils = [...svg.querySelectorAll('[data-part="pupils"]')].map((el) => ({ el, str: '' }));
    this._blushEls = [...svg.querySelectorAll('[data-part="blush"]')];
    this._blushStr = '';
    this._gripEl = svg.querySelector('[data-part="grip"]');
    this._gripStr = '';
    this._slot = svg.querySelector('[data-slot="prop"]');
    this._propRoot = null;
    if (this._slot) {
      this._propRoot = document.createElementNS(SVGNS, 'g');
      this._propRoot.setAttribute('class', 'nb-prop');
      this._slot.appendChild(this._propRoot);
    }
    this._propStr = '';
    this._jig = [];
    for (const el of svg.querySelectorAll('[data-parallax],[data-jiggle]')) {
      const pv = (el.dataset.pivot || '').trim().split(/[\s,]+/).map(Number);
      const parentPart = el.closest('[data-part]');
      const pi = parentPart && this._partIdx[parentPart.dataset.part] !== undefined ? this._partIdx[parentPart.dataset.part] : -1;
      const kind = el.dataset.jiggle || null;
      this._jig.push({
        el, kind, par: Number(el.dataset.parallax) || 0, amt: Number(el.dataset.amount) || 1,
        px: Number.isFinite(pv[0]) ? pv[0] : 100, py: Number.isFinite(pv[1]) ? pv[1] : 150, parent: pi,
        init: false, prev: [0, 0], pv: [0, 0], D: [0, 0], V: [0, 0], str: '',
        ...(kind === 'hang' ? { w: 7.5, z: 0.26 } : kind === 'spring' ? { w: 13, z: 0.3 } : { w: 17, z: 0.4 }),
      });
    }
    // Arms: rest geometry for IK.
    this._arm = {};
    for (const side of ['L', 'R']) {
      const S = this._pivots[`arm${side}`];
      const E = this._pivots[`forearm${side}`];
      const H = this._anchors[`hand${side}`];
      const ok = this._partIdx[`arm${side}`] !== undefined && this._partIdx[`forearm${side}`] !== undefined && S && E && H;
      const l1 = ok ? Math.hypot(E[0] - S[0], E[1] - S[1]) : 0;
      const l2 = ok ? Math.hypot(H[0] - E[0], H[1] - E[1]) : 0;
      this._arm[side] = {
        ok: ok && l1 > 1 && l2 > 1, S, E, H, l1, l2,
        a1: Math.atan2(E[1] - S[1], E[0] - S[0]), a2: Math.atan2(H[1] - E[1], H[0] - E[0]),
      };
    }
    const hipL = this._pivots.legL;
    this._legLen = hipL ? Math.max(20, this._anchors.ground[1] - hipL[1]) : 64;
    // Legs with knee + ankle parts (thigh > shin > foot) are solved with two-bone IK; others use the pendulum gait.
    this._knee = null;
    const legRig = (side) => {
      const H = this._pivots[`leg${side}`];
      const K = this._pivots[`shin${side}`];
      const A = this._pivots[`foot${side}`];
      const parts = [`leg${side}`, `shin${side}`, `foot${side}`].every((n) => this._partIdx[n] !== undefined);
      if (!parts || !H || !K || !A) return null;
      const a = Math.hypot(K[0] - H[0], K[1] - H[1]);
      const b = Math.hypot(A[0] - K[0], A[1] - K[1]);
      if (a < 2 || b < 2) return null;
      return {
        H, A, a, b,
        rest: [A[0] - H[0], A[1] - H[1]],
        th0: Math.atan2(K[0] - H[0], K[1] - H[1]), // rest directions, measured from straight down toward +x
        sh0: Math.atan2(A[0] - K[0], A[1] - K[1]),
        out: side === 'L' ? -1 : 1,
        half: (this._def.tuning && this._def.tuning.footHalf) || 13, // ankle → heel/toe contact corner
        tgt: null,
      };
    };
    const kL = legRig('L');
    const kR = legRig('R');
    if (kL && kR) this._knee = { L: kL, R: kR };
    this._front = {};
    this._bodyBox = null;
    this._headBox = null;
    this._debugOn = false;
  }

  _faceCenter() {
    const l = this._anchors.eyeL;
    const r = this._anchors.eyeR;
    const m = this._anchors.mouth;
    return [(l[0] + r[0]) / 2, ((l[1] + r[1]) / 2 + m[1]) / 2];
  }

  _bboxCenter(el) {
    try {
      const b = el.getBBox();
      if (b.width || b.height) return [b.x + b.width / 2, b.y + b.height];
    } catch {
      /* not rendered yet */
    }
    return null;
  }

  _initChannels() {
    this._S = {};
    this._keys = [];
    this._out = {};
    const addKey = (part, ch, rest) => {
      const [w, z] = springParams(part, ch);
      const key = `${part}.${ch}`;
      this._S[key] = { v: rest, vel: 0, w, z, b0: rest, b1: rest, dyn: 0, act: null, rest };
      this._keys.push(key);
      this._out[key] = rest;
    };
    for (const p of this._parts) for (const ch of CHANNELS) addKey(p.name, ch, REST[ch]);
    for (const [part, chs] of Object.entries(VIRTUAL)) for (const [ch, v] of Object.entries(chs)) addKey(part, ch, v);

    this._poseName = 'idle';
    this._poseT0 = 0;
    this._poseDur = 0;
    this._poseFace = {};
    this._poseVariants = {};
    this._actFace = {};
    this._actVariants = {};
    this._idleScale = { breath: 1, sway: 1 };
    this._ik = {};
    for (const side of ['L', 'R']) {
      this._ik[side] = { base: null, act: undefined, spec: null, key: 'null', w: 0, wFrom: 0, wTo: 0, wT0: 0, wDur: 0, src: { a: 0, r: 0 }, cur: null, t0: 0, dur: 0, ease: EASE.inOut, prevArm: null, prevFore: null };
    }
    this._loco = null;
    this._glide = null;
    this._gait = { phase: 0.75, dir: 1, sinA: 0, w: 0, wv: 0, active: false, lift: 7, prevQ: [0.75, 0.25], hop: null };
    this._exprName = this._exprName || MOOD[this._mood].expr;
    this._blinkAt = rand(1.5, 3.5);
    this._blinkT = -1;
    this._blinkDouble = false;
    this._saccAt = rand(0.8, 2);
    this._sacc = { x: 0, y: 0 };
    this._track = null;
    this._trackLook = { x: 0, y: 0, tilt: 0, turn: 0 };
    this._lookTilt = { v: 0, vel: 0, w: 10, z: 0.9 };
    this._talkUntil = 0;
    this._talkNext = 0;
    this._talkTarget = 0;
    this._talkOpen = 0;
    this._blush = { v: 0, from: 0, to: 0, t0: 0, dur: 0, fx: 0 };
    this._propSway = { v: 0, vel: 0 };
    this._slosh = { v: 0, vel: 0 };
    this._handPrev = null;
    this._handVel = [0, 0];
    this._level = 0.7;
    this._levelTween = null;
    this._action = null;
    this._applyPoseNow('idle');
    this._applyExpression();
  }

  _setColors() {
    const c = this._def.colors || {};
    const st = this.el.style;
    st.setProperty('--nb-primary', this._color || c.primary || '#2BB3A3');
    st.setProperty('--nb-secondary', c.secondary || '#26324D');
    st.setProperty('--nb-accent', c.accent || c.primary || '#FF8A5B');
    st.setProperty('--nb-ts', String(this._ts || 1));
  }

  _applySize() {
    this._k = this._height / 300;
    this._width = Math.round((this._height * 2) / 3);
    this.el.style.width = `${this._width}px`;
    this.el.style.height = `${this._height}px`;
    this._writeEl();
  }

  _loadCustomBox(url) {
    this._customBox = [0, 0, 200, 300];
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 200;
      const h = img.naturalHeight || 300;
      const s = Math.min(200 / w, 300 / h);
      const fw = w * s;
      const fh = h * s;
      const x0 = (200 - fw) / 2;
      const y0 = 300 - fh;
      this._customBox = [x0, y0, fw, fh];
      const A = this._anchors;
      A.top = [100, y0 + 4];
      A.mouth = [100, y0 + fh * 0.4];
      A.eyeL = [100 - fw * 0.14, y0 + fh * 0.32];
      A.eyeR = [100 + fw * 0.14, y0 + fh * 0.32];
      A.earL = [x0 + fw * 0.12, y0 + fh * 0.3];
      A.earR = [x0 + fw * 0.88, y0 + fh * 0.3];
      A.chest = [100, y0 + fh * 0.62];
      A.handL = [Math.max(16, x0 - 4), y0 + fh * 0.66];
      A.handR = [Math.min(184, x0 + fw + 4), y0 + fh * 0.66];
      this._wake();
    };
    img.src = url;
  }

  // ---------------------------------------------------------------------------------------------- poses
  _resolvePose(name) {
    const base = POSES[name] || POSES.idle;
    const over = (this._def.poses && this._def.poses[name]) || null;
    if (!over) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = { ...base[k], ...v };
      } else out[k] = v;
    }
    return out;
  }

  _poseTarget(p, key, sign) {
    const dot = key.indexOf('.');
    const part = key.slice(0, dot);
    const ch = key.slice(dot + 1);
    const vals = p[part];
    let v = vals && vals[ch] !== undefined ? vals[ch] : this._S[key].rest;
    if (p.mirror && sign < 0 && ((ch === 'rot' && (part === 'body' || part === 'torso' || part === 'head')) || key === 'view.turn' || key === 'look.x')) v = -v;
    return v;
  }

  _poseBlend() {
    return this._poseDur > 0 ? EASE.inOut(clamp((this._clock - this._poseT0) / this._poseDur, 0, 1)) : 1;
  }

  _applyPoseNow(name) {
    const p = this._resolvePose(name);
    const sign = this._facing || 1;
    for (const key of this._keys) {
      const s = this._S[key];
      s.b0 = s.b1 = this._poseTarget(p, key, sign);
      s.v = s.b1;
      s.vel = 0;
    }
    this._poseName = name;
    this._poseDur = 0;
    this._poseExtras(p, 0);
  }

  _poseExtras(p, ms) {
    this._poseFace = { ...(p.faceSets || {}) };
    this._poseVariants = { ...(p.variants || {}) };
    for (const side of ['L', 'R']) {
      this._ik[side].base = p.ik && p.ik[side] ? p.ik[side] : null;
      this._ikRefresh(side, ms, EASE.inOut);
    }
    const wantFront = new Set(p.front || []);
    for (const part of ['armL']) this._setFront(part, wantFront.has(part), 'pose');
    const over = p.propOverride || null;
    if (over !== this._propOverride) {
      this._propOverride = over;
      this._mountProp(over || this._propId);
    }
    if (p.expression) this._setExpression(p.expression);
  }

  // ---------------------------------------------------------------------------------------------- frame
  _wake() {
    if (this._destroyed) return;
    this._sleeping = false;
    wakeTicker(this);
  }

  _frame(dtReal) {
    if (this._destroyed) return;
    this._step(dtReal * this._ts, dtReal === 0 && this._clock === 0);
  }

  // One simulation step of `dt` avatar-seconds (init = snap springs to their targets).
  _step(dt, init = false) {
    if (dt > 0) this._clock += dt;
    const now = this._clock;
    if (this._timers.length) this._fireTimers(now);
    this._updateLoco(dt);
    this._updateFaceTimers(dt, now);

    const pe = this._poseBlend();
    const out = this._out;
    for (const key of this._keys) {
      const s = this._S[key];
      let tgt;
      if (s.act) {
        const a = s.act;
        const t = a.dur > 0 ? clamp((now - a.t0) / a.dur, 0, 1) : 1;
        const to = a.release ? s.b0 + (s.b1 - s.b0) * pe + s.dyn : a.to;
        tgt = a.from + (to - a.from) * a.ease(t);
        if (a.release && t >= 1) s.act = null;
      } else tgt = s.b0 + (s.b1 - s.b0) * pe + s.dyn;
      if (dt > 0) stepSpring(s, tgt, dt);
      else if (init) s.v = tgt;
      out[key] = s.v;
    }
    this._addLayers(dt, now);
    this._computeMatrices();
    this._applyIK(now);
    this._updateProp(dt, now);
    this._updateJiggles(dt);
    this._updateFace(dt, now);
    this._writeParts();
    this._writeEl();
    this._maybeSleep();
  }

  _fireTimers(now) {
    const due = this._timers.filter((t) => t.at <= now);
    if (!due.length) return;
    this._timers = this._timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  }

  _after(ms, fn) {
    if (this._destroyed) { fn(); return () => {}; }
    const t = { at: this._clock + ms / 1000, fn };
    this._timers.push(t);
    this._wake();
    return () => {
      const i = this._timers.indexOf(t);
      if (i >= 0) this._timers.splice(i, 1);
    };
  }

  _maybeSleep() {
    if (this._loco || this._glide || this._action || this._timers.length || this._ts === 0) return;
    const off = this._x + this._width < -80 || this._x > this._hostW + 80;
    if (!off) return;
    for (const key of this._keys) if (Math.abs(this._S[key].vel) > 0.01) return;
    this._sleeping = true;
    live.delete(this);
  }

  // ---------------------------------------------------------------------------------------------- layers
  _addLayers(dt, now) {
    const o = this._out;
    const add = (key, v) => {
      if (key in o) o[key] += v;
    };
    const md = MOOD[this._mood];
    const tune = this._tune;
    const g = this._gait;
    const walkW = g.active ? g.w : 0;

    // breathing
    const bAmp = md.breath * this._idleScale.breath * tune.breath;
    if (bAmp) {
      const b = Math.sin(now * TAU * md.breathHz);
      add('torso.sy', 0.011 * bAmp * b);
      add('head.y', -0.7 * bAmp * Math.sin(now * TAU * md.breathHz - 0.5));
      add('armL.rot', 0.9 * bAmp * b);
      add('armR.rot', -0.9 * bAmp * b);
    }
    // idle sway
    const sw = this._idleScale.sway * tune.sway * (1 - walkW) * (this._action ? 0.5 : 1);
    if (sw) {
      add('body.rot', 0.55 * sw * Math.sin(now * TAU * 0.13));
      add('head.rot', 1.3 * sw * Math.sin(now * TAU * 0.17 + 1.3));
      if (this._mood === 'happy') {
        add('head.rot', 1.8 * sw * Math.sin(now * TAU * 0.5));
        add('body.sy', 0.01 * sw * Math.sin(now * TAU * 1.0));
      }
    }
    // gait
    if (g.active) {
      if (g.hop) this._hopLayer(add);
      else this._walkLayer(add, md, tune);
    }
    // airborne dangle (drop entrance)
    const air = clamp((this._y - 10) / (20 * this._k), 0, 1);
    if (this._knee) {
      this._legIK();
      if (air > 0) {
        // relaxed dangle: soft knees, toes hanging, a slow out-of-phase swing
        const s1 = Math.sin(now * TAU * 0.7);
        const s2 = Math.sin(now * TAU * 0.7 + 0.8);
        add('legL.rot', air * (2 + 4 * s1));
        add('legR.rot', air * (-2 - 4 * s2));
        add('shinL.rot', air * (7 + 3 * s1));
        add('shinR.rot', air * (-7 - 3 * s2));
        add('footL.rot', air * 5);
        add('footR.rot', air * -5);
      }
    } else if (air > 0) {
      add('legL.rot', air * 7 * Math.sin(now * TAU * 0.7));
      add('legR.rot', air * -6 * Math.sin(now * TAU * 0.7 + 0.8));
      add('legL.y', air * -1.5);
      add('legR.y', air * -1.5);
    }
    // wrists: follow-through lag behind fast forearm motion, plus a relaxed flick while walking
    for (const side of ['L', 'R']) {
      if (side === 'R' && (this._propOverride || this._propId) !== 'none') continue; // the grip owns a holding hand
      const fv = this._S[`forearm${side}.rot`];
      if (fv) add(`hand${side}.rot`, clamp(-0.045 * fv.vel, -14, 14));
      if (walkW) add(`hand${side}.rot`, (side === 'L' ? 5 : -5) * walkW * Math.sin(TAU * g.phase + 0.9));
    }
    // cursor-follow head tilt
    const lt = this._lookTilt;
    if (dt > 0) stepSpring(lt, this._track ? this._trackLook.tilt : 0, dt);
    add('head.rot', lt.v);
    // follow-through: the head lags behind fast torso rotations
    const tv = this._S['torso.rot'];
    if (tv) add('head.rot', clamp(-0.035 * tv.vel, -4, 4));
    // face turn
    const turn = clamp(o['view.turn'] ?? 0, -1, 1);
    add('face.x', turn * tune.faceTurn);
    add('face.sx', -Math.abs(turn) * 0.05);
    // per-avatar extras
    if (this._def.idle) {
      const extra = this._def.idle(this._idleCtx(walkW, air, turn), now, dt);
      if (extra) for (const [part, chs] of Object.entries(extra)) for (const [ch, v] of Object.entries(chs)) add(`${part}.${ch}`, v);
    }
  }

  _idleCtx(walkW, air, turn) {
    if (!this._ictx) {
      const self = this;
      this._ictx = {
        state: this._state,
        rand,
        fx: (n, o) => self._api.fx(n, o),
        get mood() { return self._mood; },
        get facing() { return self._facing; },
        get speaking() { return self._clock < self._talkUntil; },
        get busy() { return !!self._action; },
      };
    }
    const c = this._ictx;
    c.walking = walkW;
    c.airborne = air;
    c.turn = turn;
    c.talking = this._talkOpen;
    c.state = this._state;
    return c;
  }

  _walkLayer(add, md, tune) {
    const g = this._gait;
    const L = this._legLen;
    const sinA = g.sinA * g.w;
    const dir = g.dir;
    const w = g.w;
    let lL;
    let lR;
    if (this._knee) {
      [lL, lR] = this._kneeGait(add, tune);
    } else {
      const leg = (ph) => {
        const q = frac(ph);
        if (q < 0.5) return { th: -dir * Math.asin((1 - 4 * q) * sinA), stance: true, s: q * 2 };
        const s = (q - 0.5) * 2;
        // Match the support foot's velocity at toe-off and contact (cubic Hermite).
        const reach = sinA * (1 + 2 * s - 12 * s * s + 8 * s * s * s);
        return { th: dir * Math.asin(clamp(reach, -0.95, 0.95)), stance: false, s };
      };
      lL = leg(g.phase);
      lR = leg(g.phase + 0.5);
      const stance = lL.stance ? lL : lR;
      const bob = L * (1 - Math.cos(stance.th)); // the support foot stays planted
      add('body.y', bob);
      const lift = g.lift * tune.lift;
      for (const [name, l] of [['legL', lL], ['legR', lR]]) {
        add(`${name}.rot`, l.th * R2D);
        if (!l.stance) add(`${name}.y`, L * (1 - Math.cos(l.th)) - bob - lift * Math.sin(Math.PI * l.s) ** 2 * w);
      }
    }
    const arm = md.arm * tune.armSwing * w;
    add('armL.rot', -0.72 * lL.th * R2D * arm);
    add('armR.rot', -0.72 * lR.th * R2D * arm * (this._propId !== 'none' ? 0.55 : 1));
    add('forearmL.rot', -7 * w);
    add('forearmR.rot', 7 * w);
    add('torso.rot', 1.1 * Math.sin(TAU * g.phase) * w);
    add('head.rot', 1.3 * Math.sin(TAU * 2 * g.phase + 0.6) * w);
    add('head.y', 0.8 * Math.sin(TAU * 2 * g.phase + 1.4) * w);
    add('body.rot', dir * md.lean * w);
    // footstep events when a foot plants
    const q = [frac(g.phase), frac(g.phase + 0.5)];
    for (let i = 0; i < 2; i++) {
      if (g.prevQ[i] >= 0.5 && q[i] < 0.5 && g.w > 0.15) this._emit('step', { foot: i ? 'R' : 'L' });
    }
    g.prevQ = q;
  }

  // Ankle targets for the jointed gait. Same distance sync as the pendulum gait (half stride = legLen · sinA at the
  // ground), so planted feet do not slide. Returns pendulum-equivalent angles for the arm counter-swing.
  _kneeGait(add, tune) {
    const g = this._gait;
    const K = this._knee;
    const L = this._legLen;
    const w = g.w;
    const dir = g.dir;
    const S = L * g.sinA * w;
    const lift = g.lift * tune.lift * w;
    const reach = 0.985 * Math.min(K.L.a + K.L.b, K.R.a + K.R.b);
    const state = (ph) => {
      const q = frac(ph);
      if (q < 0.5) {
        const u = q * 2;
        // heel strike → flat foot → toe-off; degrees, + = toe down toward the travel direction
        const roll = -14 * (1 - smoothstep(u / 0.18)) + 18 * smoothstep((u - 0.72) / 0.28);
        return { dx: dir * S * (1 - 2 * u), lift: 0, roll: roll * w, stance: true, s: u };
      }
      const s = (q - 0.5) * 2;
      // velocity-matched swing (cubic Hermite); the toe clears the floor, then the heel leads into contact
      const roll = 18 - 32 * smoothstep(s) - 6 * Math.sin(Math.PI * s);
      return { dx: -dir * S * (1 + 2 * s - 12 * s * s + 8 * s * s * s), lift: lift * Math.sin(Math.PI * s) ** 2, roll: roll * w, stance: false, s };
    };
    const lL = state(g.phase);
    const lR = state(g.phase + 0.5);
    const st = lL.stance ? lL : lR;
    const rig = lL.stance ? K.L : K.R;
    // Lower the hips just enough for the support leg to reach the floor with a soft knee.
    const tx = rig.rest[0] + st.dx;
    add('body.y', Math.max(0, rig.rest[1] - Math.sqrt(Math.max(0, reach * reach - tx * tx))));
    for (const [k, l] of [[K.L, lL], [K.R, lR]]) {
      k.tgt = { dx: l.dx, lift: l.lift, roll: l.roll, dir };
      l.th = -Math.asin(clamp(l.dx / L, -0.95, 0.95));
    }
    return [lL, lR];
  }

  // Two-bone leg IK (hip → knee → ankle) + foot orientation. Feet stay planted while the body crouches; the walk
  // supplies moving targets. Knees bend toward the travel/facing direction, or outward when facing the viewer.
  _legIK() {
    const K = this._knee;
    const o = this._out;
    const g = this._gait;
    const walking = g.active && !g.hop && g.w > 0.001;
    const bodyRot = o['body.rot'] || 0;
    // World (unposed) → body-local: invert the body part's translate · rotate · scale about its pivot.
    const P = this._pivots.body || [100, 300];
    const bx = o['body.x'] || 0;
    const by = o['body.y'] || 0;
    const bsx = o['body.sx'] || 1;
    const bsy = o['body.sy'] || 1;
    const cr = Math.cos(-bodyRot * D2R);
    const sr = Math.sin(-bodyRot * D2R);
    const ground = this._anchors.ground[1];
    for (const side of ['L', 'R']) {
      const k = K[side];
      const t = walking && k.tgt ? k.tgt : null;
      const dir = t ? t.dir : this._facing || k.out;
      // The rolling foot pivots about its heel or toe corner, which stays fixed on the floor.
      const roll = t ? t.roll * D2R * dir : 0; // world foot angle, + = clockwise
      const hx = k.half * bsx;
      const hy = (ground - k.H[1] - k.rest[1]) * bsy;
      const cx = Math.sign(roll); // +1 toe/heel corner on the right of the ankle, −1 on the left, 0 flat
      const ax0 = k.H[0] + k.rest[0] + (t ? t.dx : 0) + cx * hx;
      const ux = -cx * hx;
      const uy = -hy;
      const wx = ax0 + ux * Math.cos(roll) - uy * Math.sin(roll);
      const wy = ground + ux * Math.sin(roll) + uy * Math.cos(roll) - (t ? t.lift : 0);
      const dx0 = wx - P[0] - bx;
      const dy0 = wy - P[1] - by;
      const lx = P[0] + (dx0 * cr - dy0 * sr) / bsx;
      const ly = P[1] + (dx0 * sr + dy0 * cr) / bsy;
      const tx = lx - k.H[0];
      const ty = ly - k.H[1];
      const d = clamp(Math.hypot(tx, ty), Math.abs(k.a - k.b) + 0.01, (k.a + k.b) * 0.9995);
      const phi = Math.atan2(tx, ty);
      const alpha = Math.acos(clamp((k.a * k.a + d * d - k.b * k.b) / (2 * k.a * d), -1, 1));
      const beta = Math.acos(clamp((k.a * k.a + k.b * k.b - d * d) / (2 * k.a * k.b), -1, 1));
      const thigh = phi + dir * alpha;
      const shin = thigh - dir * (Math.PI - beta);
      const rT = -(thigh - k.th0) * R2D;
      const rS = -(shin - thigh - (k.sh0 - k.th0)) * R2D;
      o[`leg${side}.rot`] = rT;
      o[`shin${side}.rot`] = rS;
      o[`foot${side}.rot`] = roll * R2D - bodyRot - rT - rS;
    }
  }

  _hopLayer(add) {
    const h = this._gait.hop;
    const s = clamp(h.t / h.dur, 0, 1);
    let y = 0;
    let sy = 1;
    if (s < 0.22) {
      const e = Math.sin((s / 0.22) * (Math.PI / 2));
      sy = 1 - 0.13 * e * h.amp;
    } else if (s < 0.8) {
      const u = (s - 0.22) / 0.58;
      y = -h.height * 4 * u * (1 - u);
      sy = 1 + 0.09 * (1 - u) * (1 - u) * h.amp + 0.02 * Math.sin(Math.PI * u);
      add('legL.rot', 9 * Math.sin(Math.PI * u) * h.dir);
      add('legR.rot', 6 * Math.sin(Math.PI * u) * h.dir);
      add('armL.rot', 16 * Math.sin(Math.PI * u));
      add('armR.rot', -16 * Math.sin(Math.PI * u));
    } else {
      const e = Math.sin(((s - 0.8) / 0.2) * Math.PI);
      sy = 1 - 0.14 * e * h.amp;
    }
    add('body.y', y);
    add('body.sy', sy - 1);
    add('body.sx', (1 - sy) * 0.7);
    add('body.rot', h.dir * 3 * Math.sin(Math.PI * clamp((s - 0.22) / 0.58, 0, 1)));
  }

  // ---------------------------------------------------------------------------------------------- matrices & IK
  _computeMatrices(onlyArms) {
    const o = this._out;
    for (const p of this._parts) {
      if (onlyArms && !p.underArm) continue;
      const n = p.name;
      p.m = partMatrix(p.px, p.py, o[`${n}.rot`], o[`${n}.x`], o[`${n}.y`], o[`${n}.sx`], o[`${n}.sy`]);
      p.w = p.parent >= 0 ? mmul(this._parts[p.parent].w, p.m) : p.m;
    }
  }

  // Matrix mapping a part's local coordinates into torso-local coordinates.
  _toTorso(partName) {
    let i = this._partIdx[partName];
    while (i === undefined && PART_FALLBACK[partName]) {
      partName = PART_FALLBACK[partName];
      i = this._partIdx[partName];
    }
    if (i === undefined || i === this._torsoI || this._torsoI < 0) return IDENT;
    const chain = [];
    let p = this._parts[i];
    while (p && this._partIdx[p.name] !== this._torsoI) {
      chain.unshift(p);
      p = p.parent >= 0 ? this._parts[p.parent] : null;
    }
    if (!p) return IDENT;
    let m = IDENT;
    for (const q of chain) m = mmul(m, q.m);
    return m;
  }

  _anchorPart(name) {
    let part = this._anchorParents[name] || 'body';
    while (this._partIdx[part] === undefined && PART_FALLBACK[part]) part = PART_FALLBACK[part];
    return this._partIdx[part] !== undefined ? part : null;
  }

  _anchorTorso(name) {
    const a = this._anchors[name];
    if (!a) return [100, 150];
    const part = this._anchorPart(name);
    return part ? mapply(this._toTorso(part), a[0], a[1]) : [a[0], a[1]];
  }

  _resolveIK(side, spec) {
    let pt;
    let dx = 0;
    let dy = 0;
    let spout = false;
    if (typeof spec === 'string') pt = this._anchorTorso(spec);
    else if (Array.isArray(spec)) pt = [spec[0], spec[1]];
    else {
      pt = spec.anchor ? this._anchorTorso(spec.anchor) : [spec.x ?? 100, spec.y ?? 150];
      dx = spec.dx || 0;
      dy = spec.dy || 0;
      spout = !!spec.spout;
    }
    pt = [pt[0] + dx, pt[1] + dy];
    if (spout && side === 'R') {
      const meta = PROP_META[this._propOverride || this._propId] || PROP_META.none;
      const torsoAng = this._torsoI >= 0 ? mangle(this._parts[this._torsoI].w) : 0;
      const r = ((this._out['prop.tilt'] || 0) - torsoAng) * D2R;
      const s = this._tune.propScale;
      const [sx, sy] = meta.spout;
      pt[0] -= (sx * Math.cos(r) - sy * Math.sin(r)) * s;
      pt[1] -= (sx * Math.sin(r) + sy * Math.cos(r)) * s;
    }
    return pt;
  }

  _shoulder(side) {
    const a = this._arm[side];
    const o = this._out;
    return [a.S[0] + (o[`arm${side}.x`] || 0), a.S[1] + (o[`arm${side}.y`] || 0)];
  }

  _toPolar(side, pt) {
    const S = this._shoulder(side);
    let a = Math.atan2(pt[1] - S[1], pt[0] - S[0]) * R2D;
    if (side === 'L' && a < 0) a += 360; // L arm: keep the wrap seam on the inside (pointing right)
    return { a, r: Math.hypot(pt[0] - S[0], pt[1] - S[1]) };
  }

  _fromPolar(side, a, r) {
    const S = this._shoulder(side);
    return [S[0] + Math.cos(a * D2R) * r, S[1] + Math.sin(a * D2R) * r];
  }

  _handTorso(side) {
    const arm = this._parts[this._partIdx[`arm${side}`]];
    const fore = this._parts[this._partIdx[`forearm${side}`]];
    const H = this._arm[side].H;
    return mapply(mmul(arm.m, fore.m), H[0], H[1]);
  }

  _ikRefresh(side, ms, ease) {
    const k = this._ik[side];
    if (!this._arm[side] || !this._arm[side].ok) return;
    const spec = k.act !== undefined ? k.act : k.base;
    const key = spec ? JSON.stringify(spec) : 'null';
    if (key === k.key) return;
    k.key = key;
    const now = this._clock;
    const wNow = this._ikWeight(k, now);
    if (spec) {
      if (wNow < 0.02 || !k.cur) {
        k.src = this._toPolar(side, this._handTorso(side));
        k.prevArm = this._out[`arm${side}.rot`];
        k.prevFore = this._out[`forearm${side}.rot`];
      } else k.src = { ...k.cur };
      k.spec = spec;
      k.t0 = now;
      k.dur = ms / 1000;
      k.ease = easeFn(ease);
      k.wFrom = wNow;
      k.wTo = 1;
      k.wT0 = now;
      k.wDur = wNow < 0.02 ? Math.min(ms, 240) / 1000 : ms / 1000;
    } else {
      k.spec = null;
      k.wFrom = wNow;
      k.wTo = 0;
      k.wT0 = now;
      k.wDur = ms / 1000;
    }
  }

  _ikWeight(k, now) {
    if (k.wDur <= 0) return k.wTo;
    return lerp(k.wFrom, k.wTo, EASE.inOut(clamp((now - k.wT0) / k.wDur, 0, 1)));
  }

  _solveIK(side, pt) {
    const arm = this._arm[side];
    const S = this._shoulder(side);
    const { l1, l2 } = arm;
    const dx = pt[0] - S[0];
    const dy = pt[1] - S[1];
    let d = Math.hypot(dx, dy);
    const base = Math.atan2(dy, dx);
    let th1 = base;
    let th2 = base;
    if (d < l1 + l2 - 0.01) {
      d = Math.max(d, Math.abs(l1 - l2) + 0.01);
      const alpha = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
      const c1 = base + alpha;
      const c2 = base - alpha;
      const out = side === 'R' ? 1 : -1;
      th1 = (Math.cos(c1) - Math.cos(c2)) * out >= 0 ? c1 : c2; // elbow bends outward
      const ex = S[0] + l1 * Math.cos(th1);
      const ey = S[1] + l1 * Math.sin(th1);
      th2 = Math.atan2(pt[1] - ey, pt[0] - ex);
    }
    return { arm: (th1 - arm.a1) * R2D, fore: (th2 - th1 - (arm.a2 - arm.a1)) * R2D };
  }

  _applyIK(now) {
    let changed = false;
    for (const side of ['L', 'R']) {
      const k = this._ik[side];
      if (!this._arm[side].ok) continue;
      k.w = this._ikWeight(k, now);
      if (k.w <= 0.0005) {
        k.cur = null;
        continue;
      }
      let pt;
      if (k.spec) {
        const tp = this._toPolar(side, this._resolveIK(side, k.spec));
        const e = k.dur > 0 ? k.ease(clamp((now - k.t0) / k.dur, 0, 1)) : 1;
        k.cur = { a: lerp(k.src.a, tp.a, e), r: lerp(k.src.r, tp.r, e) };
      }
      if (!k.cur) continue;
      pt = this._fromPolar(side, k.cur.a, k.cur.r);
      const sol = this._solveIK(side, pt);
      const ka = `arm${side}.rot`;
      const kf = `forearm${side}.rot`;
      const fkA = this._out[ka];
      const fkF = this._out[kf];
      const ia = near(sol.arm, k.prevArm ?? fkA);
      const ifo = near(sol.fore, k.prevFore ?? fkF);
      k.prevArm = ia;
      k.prevFore = ifo;
      this._out[ka] = lerp(fkA, ia, k.w);
      this._out[kf] = lerp(fkF, ifo, k.w);
      changed = true;
    }
    if (changed) this._computeMatrices(true);
  }

  // ---------------------------------------------------------------------------------------------- prop
  _updateProp(dt, now) {
    if (!this._propRoot) return;
    const fi = this._partIdx.forearmR;
    const W = fi !== undefined ? this._parts[fi].w : IDENT;
    const h = this._anchors.handR;
    const k = this._k;
    // hand world velocity → inertia for prop sway and liquid slosh
    const hw = mapply(W, h[0], h[1]);
    hw[0] += this._x / k;
    hw[1] -= this._y / k;
    let ax = 0;
    if (dt > 0) {
      if (this._handPrev) {
        const vx = (hw[0] - this._handPrev[0]) / dt;
        ax = clamp((vx - this._handVel[0]) / dt, -6000, 6000);
        this._handVel[0] = vx;
      }
      this._handPrev = hw;
      const ps = this._propSway;
      const n = Math.ceil(dt / 0.0042);
      const hstep = dt / n;
      for (let i = 0; i < n; i++) {
        ps.vel += (-121 * ps.v - 2 * 0.32 * 11 * ps.vel - ax * 0.012) * hstep;
        ps.v += ps.vel * hstep;
      }
      ps.v = clamp(ps.v, -16, 16);
    }
    const tilt = (this._out['prop.tilt'] || 0) + this._propSway.v;
    const lin = [W[0], W[1], W[2], W[3], 0, 0];
    const sc = Math.sqrt(Math.abs(W[0] * W[3] - W[1] * W[2])) || 1;
    const L = mmul(minv(lin), mrot(tilt));
    const vis = this._propVisible;
    const ps = this._tune.propScale * sc;
    this._propRoot.style.opacity = String(clamp(vis, 0, 1));
    const root = [L[0] * ps, L[1] * ps, L[2] * ps, L[3] * ps, h[0], h[1]];
    const str = vis < 0.001 ? 'scale(0)' : mstr(root);
    if (str !== this._propStr) {
      this._propRoot.setAttribute('transform', str);
      this._propStr = str;
    }
    if (this._gripEl) {
      const g = mmul(mmul([1, 0, 0, 1, h[0], h[1]], [L[0] * sc, L[1] * sc, L[2] * sc, L[3] * sc, 0, 0]), [1, 0, 0, 1, -h[0], -h[1]]);
      const gs = mstr(g);
      if (gs !== this._gripStr) {
        this._gripEl.setAttribute('transform', gs);
        this._gripStr = gs;
      }
    }
    // liquid: level surface in world space, sloshing with tilt speed and hand acceleration
    if (this._water && this._waterMeta) {
      const wm = this._waterMeta;
      if (this._levelTween) {
        const t = this._levelTween;
        const e = clamp((now - t.t0) / t.dur, 0, 1);
        this._level = lerp(t.from, t.to, EASE.inOut(e));
        if (e >= 1) this._levelTween = null;
      }
      const sl = this._slosh;
      if (dt > 0) {
        const tiltVel = this._S['prop.tilt'].vel;
        const n = Math.ceil(dt / 0.0042);
        const hstep = dt / n;
        for (let i = 0; i < n; i++) {
          sl.vel += (-72 * sl.v - 2 * 0.16 * 8.5 * sl.vel - ax * 0.018 - tiltVel * 0.9) * hstep;
          sl.v += sl.vel * hstep;
        }
        sl.v = clamp(sl.v, -22, 22);
      }
      const r = tilt * D2R;
      const extent = Math.abs(wm.halfH * Math.cos(r)) + Math.abs(wm.halfW * Math.sin(r));
      const d = (1 - 2 * this._level) * extent;
      const wave = -((now * 7 + sl.v * 0.4) % 22);
      const wstr = `translate(${wm.cx} ${wm.cy}) rotate(${(-tilt + sl.v).toFixed(2)}) translate(${wave.toFixed(2)} ${d.toFixed(2)})`;
      if (wstr !== this._waterStr) {
        this._water.setAttribute('transform', wstr);
        this._waterStr = wstr;
      }
    }
  }

  // Releases the held prop as a free-flying copy (gravity + spin, until it leaves the screen) and mounts the
  // reminder prop hidden in the hand; the throwing action reveals it after its follow-through.
  // vx / vy are in avatar heights per second, spin in degrees per second.
  _tossProp({ vx = 1, vy = -1, spin = 360, gravity = 2.6 } = {}) {
    const root = this._propRoot;
    const world = this._fxWorld;
    const ctm = root && world.isConnected ? root.getScreenCTM() : null;
    if (ctm && this._propVisible > 0.01) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none';
      const g = document.createElementNS(ns, 'g');
      g.innerHTML = root.innerHTML; // gradient references still resolve against the avatar's own defs
      svg.append(g);
      world.append(svg);
      const wr = world.getBoundingClientRect();
      const m0 = new DOMMatrix([ctm.a, ctm.b, ctm.c, ctm.d, ctm.e - wr.left, ctm.f - wr.top]);
      const p0 = m0.transformPoint(new DOMPoint(0, 0)); // the grip point
      const H = this._height;
      // inherit part of the swinging hand's velocity (avatar units/s → px/s)
      const st = { x: p0.x, y: p0.y, vx: vx * H + clamp(this._handVel[0] * this._k * 0.35, -H, H), vy: vy * H, a: 0, t: 0 };
      const place = () => {
        const m = new DOMMatrix().translate(st.x, st.y).rotate(st.a).translate(-p0.x, -p0.y).multiply(m0);
        g.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
      };
      place();
      let last = performance.now();
      const fly = (now) => {
        if (!svg.isConnected) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        // exact integration of constant gravity over the frame
        st.x += st.vx * dt;
        st.y += st.vy * dt + 0.5 * gravity * H * dt * dt;
        st.vy += gravity * H * dt;
        st.a += spin * dt;
        st.t += dt;
        place();
        if (st.t > 4 || st.y > wr.height + H || st.x < -H * 1.5 || st.x > wr.width + H * 1.5) svg.remove();
        else requestAnimationFrame(fly);
      };
      requestAnimationFrame(fly);
    }
    if (this._propVisAnim) {
      this._propVisAnim();
      this._propVisAnim = null;
    }
    this._propVisible = 0;
    this._propOverride = null;
    this._mountProp(this._propId);
  }

  _mountProp(id) {
    if (!this._propRoot) return;
    const pid = PROP_META[id] ? id : 'none';
    const markup = pid === 'emoji' ? renderProp('emoji', '') : renderProp(pid);
    this._propRoot.innerHTML = namespaceIds(markup, `${this._suffix}p${++this._propSeqN}`);
    if (pid === 'emoji') {
      const t = this._propRoot.querySelector('text');
      if (t) t.textContent = this._emoji || '⭐';
    }
    this._water = this._propRoot.querySelector('[data-part="water"]');
    this._waterMeta = PROP_META[pid].water || null;
    this._waterStr = '';
    if (this._waterMeta && !this._propOverride) this._level = this._waterMeta.level;
    this._propStr = '';
    if (this._gripEl) this._gripEl.style.display = PROP_META[pid].grip === false ? 'none' : '';
    this._syncAnimRates();
  }

  // ---------------------------------------------------------------------------------------------- jiggles
  _updateJiggles(dt) {
    if (!this._jig.length) return;
    const k = this._k;
    const ox = this._x / k;
    const oy = -this._y / k;
    const turn = clamp(this._out['view.turn'] || 0, -1, 1);
    for (const j of this._jig) {
      const tx = j.par * turn;
      let ty = 0;
      let rot = 0;
      if (j.kind) {
        const W = j.parent >= 0 ? this._parts[j.parent].w : IDENT;
        const p = mapply(W, j.px, j.py);
        p[0] += ox;
        p[1] += oy;
        if (!j.init) {
          j.prev = p;
          j.pv = [0, 0];
          j.D = [0, 0];
          j.V = [0, 0];
          j.init = true;
        }
        if (dt > 0) {
          const vx = (p[0] - j.prev[0]) / dt;
          const vy = (p[1] - j.prev[1]) / dt;
          const ax = clamp((vx - j.pv[0]) / dt, -5000, 5000);
          const ay = clamp((vy - j.pv[1]) / dt, -5000, 5000);
          j.prev = p;
          j.pv = [vx, vy];
          const n = Math.ceil(dt / 0.0042);
          const h = dt / n;
          const w2 = j.w * j.w;
          const c = 2 * j.z * j.w;
          for (let i = 0; i < n; i++) {
            j.V[0] += (-w2 * j.D[0] - c * j.V[0] - ax) * h;
            j.V[1] += (-w2 * j.D[1] - c * j.V[1] - ay) * h;
            j.D[0] += j.V[0] * h;
            j.D[1] += j.V[1] * h;
          }
          j.D[0] = clamp(j.D[0], -12, 12);
          j.D[1] = clamp(j.D[1], -12, 12);
        }
        const ang = Math.atan2(W[1], W[0]);
        const cs = Math.cos(-ang);
        const sn = Math.sin(-ang);
        const lx = j.D[0] * cs - j.D[1] * sn;
        const ly = j.D[0] * sn + j.D[1] * cs;
        if (j.kind === 'hang') rot = clamp(-lx * 7 * j.amt, -32, 32) - ang * R2D * 0.9;
        else if (j.kind === 'spring') rot = clamp(lx * 5 * j.amt, -22, 22);
        else {
          ty = clamp(ly * 0.8 * j.amt, -3.5, 3.5);
          rot = clamp(lx * 1.4 * j.amt, -5, 5);
        }
      }
      const str = `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${rot.toFixed(2)} ${j.px} ${j.py})`;
      if (str !== j.str) {
        j.el.setAttribute('transform', str);
        j.str = str;
      }
    }
  }

  _resetMotionMemory() {
    for (const j of this._jig) j.init = false;
    this._handPrev = null;
    this._handVel = [0, 0];
  }

  // ---------------------------------------------------------------------------------------------- face
  _updateFaceTimers(dt, now) {
    // blink
    if (this._blinkT < 0 && now >= this._blinkAt) {
      this._blinkT = 0;
      this._blinkDouble = Math.random() < 0.22;
      this._blinkAt = now + rand(2.5, 5.5);
    } else if (this._blinkT >= 0) {
      this._blinkT += dt;
      if (this._blinkT > 0.2) {
        if (this._blinkDouble) {
          this._blinkDouble = false;
          this._blinkT = -0.08;
          this._blinkAt = now + 0.08;
        } else this._blinkT = -1;
      }
    }
    // saccades (idle glances) when not tracking the cursor
    if (now >= this._saccAt) {
      const big = Math.random() < 0.25;
      this._sacc = { x: rand(-1, 1) * (big ? 0.8 : 0.32), y: rand(-1, 1) * (big ? 0.45 : 0.18) };
      this._saccAt = now + rand(1.2, 4);
    }
    const look = this._track ? this._trackLook : this._sacc;
    this._S['look.x'].dyn = look.x;
    this._S['look.y'].dyn = look.y;
    this._S['view.turn'].dyn = this._facing * 0.85 + (this._track ? this._trackLook.turn : 0);
    // talking mouth
    if (now < this._talkUntil) {
      if (now >= this._talkNext) {
        this._talkTarget = Math.random() < 0.22 ? 0 : rand(0.35, 1);
        this._talkNext = now + rand(0.075, 0.145);
      }
    } else this._talkTarget = 0;
    if (dt > 0) this._talkOpen += (this._talkTarget - this._talkOpen) * (1 - Math.exp(-dt * 32));
    // blush tween
    const b = this._blush;
    if (b.dur > 0) {
      const e = clamp((now - b.t0) / b.dur, 0, 1);
      b.fx = lerp(b.from, b.to, EASE.inOut(e));
      if (e >= 1) b.dur = 0;
    }
  }

  _faceSets() {
    const ex = EXPRESSIONS[this._exprName] || EXPRESSIONS.neutral;
    return { eyes: ex.eyes, brows: ex.brows, mouth: ex.mouth, ...this._poseFace, ...this._actFace };
  }

  _showVariant(set, value) {
    const vs = this._variants[set];
    if (!vs) return;
    let v = value;
    for (let guard = 0; v && !vs[v] && guard < 4; guard++) v = VARIANT_FALLBACK[`${set}:${v}`];
    if (!v || !vs[v]) v = Object.keys(vs)[0];
    if (this._shown[set] === v) return;
    for (const [name, fs] of Object.entries(vs)) for (const f of fs) f.to = name === v ? 1 : 0;
    this._shown[set] = v;
  }

  // Variant cross-fades run on the avatar clock (slow motion / advance() / hidden windows all stay consistent).
  _stepFades(dt) {
    const talk = this._clock < this._talkUntil;
    for (const f of this._fades) {
      if (f.v === f.to) continue;
      const rate = f.set === 'mouth' && talk ? 70 : 30;
      f.v = dt > 0 ? f.v + (f.to - f.v) * (1 - Math.exp(-dt * rate)) : f.to;
      if (Math.abs(f.to - f.v) < 0.02) f.v = f.to;
      const str = f.v.toFixed(2);
      if (str !== f.str) {
        f.el.style.opacity = str;
        f.str = str;
      }
    }
  }

  _updateFace(dt, now) {
    const sets = this._faceSets();
    const talking = this._talkOpen > 0.18;
    for (const set of Object.keys(this._variants)) {
      let v;
      if (set === 'mouth') v = talking ? 'o' : sets.mouth;
      else if (set === 'eyes' || set === 'brows') v = sets[set];
      else v = this._actVariants[set] ?? this._poseVariants[set] ?? null;
      this._showVariant(set, v);
    }
    this._stepFades(dt);
    // eyes: blink squash + surprise scale about the eye midpoint
    if (this._eyeEls.length) {
      let sy = 1;
      const t = this._blinkT;
      if (t >= 0) sy = t < 0.06 ? lerp(1, 0.08, EASE.inQuad(t / 0.06)) : t < 0.1 ? 0.08 : lerp(0.08, 1, EASE.outQuad(clamp((t - 0.1) / 0.09, 0, 1)));
      const es = (EXPRESSIONS[this._exprName] || {}).eyeScale || 1;
      const l = this._anchors.eyeL;
      const r = this._anchors.eyeR;
      const cx = (l[0] + r[0]) / 2;
      const cy = (l[1] + r[1]) / 2;
      const str = sy === 1 && es === 1 ? '' : `translate(${cx} ${cy}) scale(${es.toFixed(3)} ${(es * sy).toFixed(3)}) translate(${-cx} ${-cy})`;
      if (str !== this._eyeStr) {
        for (const el of this._eyeEls) {
          if (str) el.setAttribute('transform', str);
          else el.removeAttribute('transform');
        }
        this._eyeStr = str;
      }
    }
    // pupils
    if (this._pupils.length) {
      const [rx, ry] = this._tune.pupil;
      const turn = clamp(this._out['view.turn'] || 0, -1, 1);
      const lx = clamp(this._out['look.x'], -1.2, 1.2) * rx + turn * 1.6;
      const ly = clamp(this._out['look.y'], -1.2, 1.2) * ry;
      const str = `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`;
      for (const p of this._pupils) {
        if (str !== p.str) {
          p.el.setAttribute('transform', str);
          p.str = str;
        }
      }
    }
    // talking / yawning mouth scale
    if (this._mouthO.length) {
      if (!this._mouthOC) this._mouthOC = this._bboxMid(this._mouthO[0]) || this._anchors.mouth;
      const open = this._out['mouth.open'] ?? 1;
      const talkS = talking ? 0.42 + 0.58 * this._talkOpen : 1;
      const sy = open * talkS;
      const sx = (0.92 + 0.08 * talkS) * (open > 1 ? 1 + (open - 1) * 0.35 : 1);
      const [cx, cy] = this._mouthOC;
      const str = Math.abs(sy - 1) < 0.002 && Math.abs(sx - 1) < 0.002 ? '' : `translate(${cx} ${cy}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(${-cx} ${-cy})`;
      if (str !== this._mouthOStr) {
        for (const el of this._mouthO) {
          if (str) el.setAttribute('transform', str);
          else el.removeAttribute('transform');
        }
        this._mouthOStr = str;
      }
    }
    // blush
    if (this._blushEls.length) {
      const target = Math.max((EXPRESSIONS[this._exprName] || {}).blush || 0, this._blush.fx);
      if (dt > 0) this._blush.v += (target - this._blush.v) * (1 - Math.exp(-dt * 8));
      else this._blush.v = target;
      const str = this._blush.v.toFixed(3);
      if (str !== this._blushStr) {
        for (const el of this._blushEls) el.style.opacity = str;
        this._blushStr = str;
      }
    }
  }

  _bboxMid(el) {
    try {
      const b = el.getBBox();
      if (b.width || b.height) return [b.x + b.width / 2, b.y + b.height / 2];
    } catch {
      /* not rendered */
    }
    return null;
  }

  _blushTo(v, ms) {
    const b = this._blush;
    b.from = b.fx;
    b.to = v;
    b.t0 = this._clock;
    b.dur = Math.max(0.001, ms / 1000);
    this._wake();
  }

  _applyExpression() {
    if (!this._def.onExpression) return;
    try {
      this._def.onExpression({ el: this.el, svg: this._svg, av: this._api, state: this._state }, this._exprName);
    } catch (e) {
      console.error(e);
    }
  }

  // ---------------------------------------------------------------------------------------------- output
  _writeParts() {
    for (const p of this._parts) {
      const str = mstr(p.m);
      if (str !== p.str) {
        p.el.setAttribute('transform', str);
        p.str = str;
      }
    }
    // contact shadow stays on the ground and shrinks while airborne
    if (this._shadow) {
      const k = this._k;
      const lift = Math.max(0, -(this._out['body.y'] || 0)) + this._y / k;
      const s = 1 / (1 + lift / 90);
      const bx = this._out['body.x'] || 0;
      const sq = this._out['body.sx'] || 1;
      const str = `translate(${(100 + bx).toFixed(2)} ${(299 + this._y / k).toFixed(2)}) scale(${(s * sq).toFixed(3)} ${s.toFixed(3)}) translate(-100 -299)`;
      if (str !== this._shadowStr) {
        this._shadow.setAttribute('transform', str);
        this._shadow.style.opacity = (0.35 + 0.65 * s).toFixed(3);
        this._shadowStr = str;
      }
    }
  }

  _writeEl() {
    const str = `translate3d(${this._x.toFixed(2)}px, ${(-this._y).toFixed(2)}px, 0)`;
    if (str !== this._elStr) {
      this.el.style.transform = str;
      this._elStr = str;
    }
  }

  // ---------------------------------------------------------------------------------------------- locomotion
  _updateLoco(dt) {
    const g = this._gait;
    const L = this._loco;
    if (this._glide) this._updateGlide();
    if (!L) {
      if (g.active) {
        // settle: lower the lifted foot, legs back to rest
        g.w = Math.max(0, g.w - dt * 6);
        if (g.hop) g.active = false;
        else if (g.w <= 0) g.active = false;
      }
      return;
    }
    if (dt <= 0) return;
    if (L.kind === 'walk') {
      const remain = Math.abs(L.to - this._x);
      const accel = L.speed / 0.3;
      const decel = L.speed / 0.36;
      const vMax = Math.min(L.speed, Math.sqrt(2 * decel * remain) + 2);
      L.v = L.v < vMax ? Math.min(vMax, L.v + accel * dt) : vMax;
      let step = L.v * dt;
      let arrived = false;
      if (step >= remain - 0.05) {
        step = remain;
        arrived = true;
      }
      this._x += L.dir * step;
      g.phase += step / this._k / L.cycle;
      const wT = clamp(L.v / L.speed, 0, 1);
      g.w += (wT - g.w) * (1 - Math.exp(-dt * 10));
      if (arrived) {
        this._x = L.to;
        g.phase = L.endPhase;
        this._finishLoco(true);
      }
    } else {
      const h = g.hop;
      h.t += dt;
      const s = clamp(h.t / h.dur, 0, 1);
      const u = clamp((s - 0.22) / 0.58, 0, 1);
      this._x = h.x0 + h.dir * h.len * EASE.inOutSine(u);
      if (s >= 1) {
        this._emit('step', { foot: 'both' });
        this._emit('land', {});
        L.hopsDone++;
        if (L.hopsDone >= L.hops) {
          this._x = L.to;
          this._finishLoco(true);
        } else {
          h.t -= h.dur;
          h.x0 = L.from + L.dir * h.len * L.hopsDone;
        }
      }
    }
  }

  _finishLoco(ok) {
    const L = this._loco;
    if (!L) return;
    this._loco = null;
    if (L.kind === 'hop') this._gait.active = false;
    this._facing = L.endFacing;
    L.resolve(ok);
  }

  _updateGlide() {
    const gl = this._glide;
    const t = clamp((this._clock - gl.t0) / gl.dur, 0, 1);
    const e = gl.ease(t);
    const swayX = gl.sway ? canopySway(t).offset * gl.sway : 0;
    this._x = lerp(gl.x0, gl.x1, e) + swayX * this._k;
    this._y = lerp(gl.y0, gl.y1, e);
    const br = this._S['body.rot'];
    if (gl.sway && br) br.dyn = canopySway(t).roll * gl.sway * 0.18;
    if (t >= 1) {
      this._x = gl.x1;
      this._y = gl.y1;
      if (br) br.dyn = 0;
      this._glide = null;
      gl.resolve(true);
    }
  }

  // ---------------------------------------------------------------------------------------------- action ctx
  _makeCtx(token, opts) {
    const self = this;
    const guard = () => {
      if (token.cancelled) throw CANCEL;
    };
    const wait = (ms) => {
      const pending = new Promise((res, rej) => {
        if (token.cancelled) return rej(CANCEL);
        self._after(ms, () => (token.cancelled ? rej(CANCEL) : res()));
      });
      pending.catch(() => {});
      return pending;
    };
    const ctx = {
      av: this._api,
      def: this._def,
      opts,
      state: this._state,
      rand,
      get cancelled() { return token.cancelled; },
      get mood() { return self._mood; },
      get facing() { return self._facing; },
      get propId() { return self._propOverride || self._propId; },
      get propMeta() { return PROP_META[self._propOverride || self._propId] || PROP_META.none; },
      get t() { return self._clock; },
      get knees() { return !!self._knee; },
      toss(o) {
        guard();
        self._tossProp(o);
      },
      to(values, ms = 300, ease = 'inOut') {
        guard();
        self._actTo(values, ms, ease);
        return wait(ms);
      },
      set(values) {
        guard();
        self._actTo(values, 0, 'linear');
      },
      wait(ms) {
        guard();
        return wait(ms);
      },
      ik(side, target, ms = 450, ease = 'inOut') {
        guard();
        if (!self._ik[side]) return wait(0);
        self._ik[side].act = target ?? null;
        self._ikRefresh(side, ms, ease);
        return wait(ms);
      },
      reach(side, angle, ext = 1.05) {
        const a = self._arm[side];
        if (!a || !a.ok) return [100, 150];
        const r = (a.l1 + a.l2) * ext;
        const dirOut = side === 'L' ? -1 : 1;
        const th = angle * D2R;
        return [a.S[0] + dirOut * Math.sin(th) * r, a.S[1] + Math.cos(th) * r];
      },
      expression(name) {
        guard();
        self._setExpression(name);
      },
      face(sets) {
        guard();
        Object.assign(self._actFace, sets);
      },
      variant(set, value) {
        guard();
        if (value == null) delete self._actVariants[set];
        else self._actVariants[set] = value;
      },
      blink() {
        self._blinkT = 0;
        self._blinkAt = self._clock + rand(2.5, 5);
      },
      say(ms) {
        guard();
        self._api.say(ms);
      },
      fx(name, o) {
        return self._api.fx(name, o);
      },
      prop(tilt, ms = 300, ease = 'inOut') {
        return ctx.to({ prop: { tilt } }, ms, ease);
      },
      drain(amount, ms = 250) {
        guard();
        self._levelTween = { from: self._level, to: clamp(self._level - amount, 0.05, 1), t0: self._clock, dur: ms / 1000 };
        if (self._propRoot) {
          self._propRoot.classList.add('is-glug');
          self._after(ms + 500, () => self._propRoot && self._propRoot.classList.remove('is-glug'));
        }
      },
      propVisible(on, ms = 200) {
        guard();
        self._propVisTween(on ? 1 : 0, ms);
      },
      front(part, on) {
        guard();
        self._setFront(part, !!on, 'action');
      },
      idle(scales) {
        Object.assign(self._idleScale, scales);
      },
      squash(amount, ms = 160, ease = 'out') {
        return ctx.to({ body: { sy: 1 - amount, sx: 1 + amount * 0.6 } }, ms, ease);
      },
      async hop({ height = 30, ms = 600, squash = 0.15, arms = null } = {}) {
        const h = height * self._tune.hopHeight;
        const c = ms * 0.22;
        const air = ms * 0.56;
        const land = ms * 0.22;
        // Jointed legs absorb with the knees (the hips dip); rigid legs squash the whole body instead.
        const sq = self._knee ? squash * 0.45 : squash;
        const dip = self._knee ? squash * 30 : 0;
        const up = arms === 'up' ? { armL: { rot: 150 }, armR: { rot: -150 } }
          : arms === 'out' ? { armL: { rot: 50 }, forearmL: { rot: -22 }, armR: { rot: -50 }, forearmR: { rot: 22 } } : {};
        const down = arms ? { armL: { rot: -8 }, armR: { rot: 8 } } : {};
        await ctx.to({ body: { sy: 1 - sq, sx: 1 + sq * 0.6, y: dip }, ...down }, c, 'out');
        ctx.to({ body: { sy: 1 + sq * 0.55, sx: 1 - sq * 0.3 }, ...up }, air * 0.32, 'out');
        self._emit('hop', {});
        await ctx.to({ body: { y: -h } }, air / 2, 'outQuad');
        ctx.to({ body: { sy: 1, sx: 1 } }, air * 0.4, 'inOut');
        await ctx.to({ body: { y: 0 } }, air / 2, 'inQuad');
        self._emit('land', {});
        await ctx.to({ body: { sy: 1 - sq * 1.15, sx: 1 + sq * 0.75, y: dip * 1.1 } }, land * 0.42, 'out');
        const rest = arms ? { armL: { rot: self._S['armL.rot']?.b1 ?? 0 }, armR: { rot: self._S['armR.rot']?.b1 ?? 0 }, forearmL: { rot: self._S['forearmL.rot']?.b1 ?? 0 }, forearmR: { rot: self._S['forearmR.rot']?.b1 ?? 0 } } : {};
        await ctx.to({ body: { sy: 1, sx: 1, y: 0 }, ...rest }, land * 0.58, 'out');
      },
      anchor(name) {
        return self._anchorTorso(name);
      },
      base(part, ch) {
        const s = self._S[`${part}.${ch}`];
        return s ? s.b1 : undefined;
      },
      emit(name, data) {
        self._emit(name, data);
      },
    };
    return ctx;
  }

  _actTo(values, ms, ease) {
    const now = this._clock;
    const ef = easeFn(ease);
    for (const [part, chs] of Object.entries(values || {})) {
      if (!chs) continue;
      for (const [ch, v] of Object.entries(chs)) {
        const s = this._S[`${part}.${ch}`];
        if (!s || typeof v !== 'number') continue;
        const from = s.act ? this._actValue(s, now) : s.v;
        s.act = { from, to: v, t0: now, dur: ms / 1000, ease: ef, release: false };
      }
    }
    this._wake();
  }

  _actValue(s, now) {
    const a = s.act;
    const t = a.dur > 0 ? clamp((now - a.t0) / a.dur, 0, 1) : 1;
    const to = a.release ? s.b0 + (s.b1 - s.b0) * this._poseBlend() + s.dyn : a.to;
    return a.from + (to - a.from) * a.ease(t);
  }

  _releaseAction(ms) {
    const now = this._clock;
    for (const key of this._keys) {
      const s = this._S[key];
      if (s.act && !s.act.release) s.act = { from: this._actValue(s, now), to: 0, t0: now, dur: ms / 1000, ease: EASE.inOut, release: true };
    }
    this._actFace = {};
    this._actVariants = {};
    this._idleScale = { breath: 1, sway: 1 };
    for (const side of ['L', 'R']) {
      if (this._ik[side].act !== undefined) {
        this._ik[side].act = undefined;
        this._ikRefresh(side, ms + 100, EASE.inOut);
      }
    }
    this._setFront('armL', false, 'action');
    if (this._propVisible < 1) this._propVisTween(1, 240);
  }

  _setFront(part, on, layer) {
    const p = this._partIdx[part];
    const head = this._partIdx.head;
    if (p === undefined || head === undefined) return;
    const st = (this._front[part] ||= { pose: false, action: false, moved: false, home: null });
    st[layer] = on;
    const want = st.pose || st.action;
    const el = this._parts[p].el;
    const headEl = this._parts[head].el;
    if (el.parentNode !== headEl.parentNode) return;
    if (want && !st.moved) {
      st.home = el.nextSibling;
      st.moved = true;
      headEl.after(el);
    } else if (!want && st.moved) {
      if (st.home && st.home.parentNode === el.parentNode && st.home !== el) el.parentNode.insertBefore(el, st.home);
      else headEl.before(el);
      st.moved = false;
      st.home = null;
    }
  }

  _propVisTween(to, ms) {
    const from = this._propVisible;
    const t0 = this._clock;
    const dur = Math.max(1, ms) / 1000;
    if (this._propVisAnim) this._propVisAnim();
    const step = () => {
      const e = clamp((this._clock - t0) / dur, 0, 1);
      this._propVisible = lerp(from, to, EASE.inOut(e));
      if (e < 1) this._propVisAnim = this._after(16, step);
      else {
        this._propVisible = to;
        this._propVisAnim = null;
      }
    };
    step();
  }

  _setExpression(name) {
    const n = EXPRESSIONS[name] ? name : 'neutral';
    if (n === this._exprName) return;
    this._exprName = n;
    this._applyExpression();
    this._wake();
  }

  _cancelAction() {
    const a = this._action;
    if (!a) return;
    a.token.cancelled = true;
    this._action = null;
    this._releaseAction(300);
    this._setExpression(a.exprBefore);
  }

  _emit(name, data) {
    const set = this._listeners.get(name);
    if (set) for (const cb of [...set]) {
      try {
        cb(data);
      } catch (e) {
        console.error(e);
      }
    }
  }

  _makeFxCtx() {
    const self = this;
    return {
      get world() { return self._fxWorld; },
      get local() { return self._fxLocal; },
      get width() { return self._width; },
      get height() { return self._height; },
      get k() { return self._height / 250; },
      anchorWorld: (n) => self._api.anchor(n),
      anchorLocal: (n) => {
        const a = self._api.anchor(n);
        return { x: a.x - self._x, y: a.y - (self._hostH - self._height - self._y) };
      },
      track(anim) {
        anim.playbackRate = self._ts;
        self._anims.add(anim);
        const drop = () => self._anims.delete(anim);
        anim.finished.then(drop, drop);
        return anim;
      },
      after: (ms, fn) => self._after(ms, fn),
      setBlush: (v, ms) => self._blushTo(v, ms),
      emit: (n, d) => self._emit(n, d),
    };
  }

  _syncAnimRates() {
    const rate = this._ts;
    for (const a of this._anims) a.playbackRate = rate;
    if (!this.el.getAnimations) return;
    for (const a of this.el.getAnimations({ subtree: true })) {
      if (typeof CSSTransition === 'undefined' || !(a instanceof CSSTransition)) a.playbackRate = rate;
    }
  }

  // ---------------------------------------------------------------------------------------------- debug
  _drawDebug() {
    for (const el of this._svg.querySelectorAll('.nb-debug')) el.remove();
    if (!this._debugOn) return;
    const mk = (parent, html) => {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'nb-debug');
      g.innerHTML = html;
      parent.appendChild(g);
    };
    for (const p of this._parts) {
      mk(p.el, `<circle cx="${p.px}" cy="${p.py}" r="2.6" fill="#FF2D6F" fill-opacity=".85" stroke="#fff" stroke-width=".8"/>` +
        `<text x="${p.px + 3.5}" y="${p.py - 3}" font-size="5.5" font-family="monospace" fill="#FF2D6F" stroke="#fff" stroke-width="1.6" paint-order="stroke">${p.name}</text>`);
    }
    for (const [name, a] of Object.entries(this._anchors)) {
      const part = this._anchorPart(name);
      const parentEl = part ? this._parts[this._partIdx[part]].el : this._svg;
      mk(parentEl, `<path d="M${a[0] - 3.5},${a[1]} h7 M${a[0]},${a[1] - 3.5} v7" stroke="#2B7CFF" stroke-width="1.2"/>` +
        `<text x="${a[0] + 3}" y="${a[1] + 7.5}" font-size="5" font-family="monospace" fill="#2B7CFF" stroke="#fff" stroke-width="1.6" paint-order="stroke">${name}</text>`);
    }
  }
}

// ------------------------------------------------------------------------------------------------- public facade
/**
 * Creates an avatar inside `host` (made position:relative if static).
 * opts: { avatarId, customUrl, color, height = 250, prop = 'none', emoji, x = 0, facing, mood, timeScale = 1 }
 */
export function createAvatar(host, opts = {}) {
  opts = { height: 360, ...opts };
  let current;
  let destroyed = false;
  let color = opts.color ?? null;
  let poseName = 'idle';
  let expressionName = null;
  let tracking = null;
  let requestedId = opts.avatarId || 'nova';
  let customUrl = opts.customUrl;
  const subscriptions = new Set();

  function swap(id, url, fallback = false) {
    if (destroyed) return;
    const previous = current;
    const state = previous ? {
      height: previous.height, x: previous.x, mood: previous.mood,
      prop: previous.prop, emoji: previous.emoji, facing: previous.facing,
      timeScale: previous.timeScale, color,
    } : { ...opts, color };
    const y = previous?.y || 0;
    if (!fallback) { requestedId = id; customUrl = url; }
    for (const sub of subscriptions) sub.off?.();
    previous?.destroy();
    // Kai renders in 3D by default and falls back to the 2D rig when WebGL or the model is unavailable
    // (`flat: true` asks for the 2D rig directly, e.g. for the 2D motion checks).
    const kai3d = id === 'nova' && !fallback && !opts.flat && !kai3dFailed;
    current = id === 'me3d' || kai3d
      ? createAvatar3D(host, { ...state, avatarId: id, modelUrl: kai3d ? KAI3D_URL : url, onFail: () => { if (kai3d) kai3dFailed = true; swap('nova', null, true); } })
      : createAvatar2D(host, { ...state, avatarId: id, customUrl: url });
    current.y = y;
    current.pose(poseName, { duration: 0 });
    if (expressionName) current.expression(expressionName);
    if (tracking) current.lookAt(...tracking);
    for (const sub of subscriptions) sub.off = current.on(sub.name, sub.cb);
  }

  const facade = {
    setAvatar(id = 'nova', url) {
      if (id === requestedId && url === customUrl) return;
      swap(id, url);
    },
    setColor(value) { color = value; current.setColor(value); },
    pose(name, options) { poseName = name; return current.pose(name, options); },
    expression(name) { expressionName = name; return current.expression(name); },
    lookAt(x, y) { tracking = x == null ? null : [x, y]; return current.lookAt(x, y); },
    on(name, cb) {
      const sub = { name, cb, off: current.on(name, cb) };
      subscriptions.add(sub);
      return () => { sub.off?.(); subscriptions.delete(sub); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const sub of subscriptions) sub.off?.();
      subscriptions.clear();
      current.destroy();
    },
  };
  swap(requestedId, customUrl);
  // Keep the public object stable while replacing its rendering backend.
  return new Proxy(facade, {
    get(target, key) {
      if (key in target) return target[key];
      const value = current[key];
      return typeof value === 'function' ? (...args) => current[key](...args) : value;
    },
    set(target, key, value) { current[key] = value; return true; },
  });
}

function createAvatar2D(host, opts = {}) {
  const a = new Avatar(host, opts);
  const api = {
    get el() { return a.el; },
    get width() { return a._width; },
    get height() { return a._height; },
    get x() { return a._x; },
    set x(v) {
      a._x = Number(v) || 0;
      a._resetMotionMemory();
      a._writeEl();
      a._wake();
    },
    get y() { return a._y; },
    set y(v) {
      a._y = Number(v) || 0;
      a._resetMotionMemory();
      a._writeEl();
      a._wake();
    },
    get timeScale() { return a._ts; },
    set timeScale(v) {
      a._ts = Math.max(0, Number(v) || 0);
      a.el.style.setProperty('--nb-ts', String(a._ts || 1));
      a._syncAnimRates();
      a._wake();
    },
    get mood() { return a._mood; },
    get facing() { return a._facing; },
    get busy() { return !!a._action; },
    get action() { return a._action ? a._action.name : null; },
    get def() { return a._def; },
    get avatarId() { return a._avatarId; },
    get prop() { return a._propId; },

    setFacing(f) {
      a._facing = clamp(Math.round(Number(f) || 0), -1, 1);
      a._wake();
    },

    walkTo(x, { speed, mood } = {}) {
      a._wake();
      if (a._loco) a._finishLoco(false);
      if (a._glide) {
        a._glide.resolve(false);
        a._glide = null;
      }
      const dist = x - a._x;
      if (Math.abs(dist) < 0.5) {
        a._x = x;
        a._writeEl();
        return Promise.resolve(true);
      }
      const dir = Math.sign(dist);
      const m = MOOD[mood] ? mood : a._mood;
      const md = MOOD[m];
      const tune = a._tune;
      const g = a._gait;
      const D = Math.abs(dist) / a._k; // avatar units
      return new Promise((resolve) => {
        if ((a._def.locomotion || 'walk') === 'hop') {
          const nominal = 66 * tune.hopLength;
          const hops = Math.max(1, Math.round(D / nominal));
          const len = Math.abs(dist) / hops;
          const dur = speed ? clamp(len / speed / 0.58, 0.32, 0.9) : md.hopDur;
          g.hop = { t: 0, dur, len, dir, x0: a._x, height: md.hopH * tune.hopHeight, amp: m === 'sad' ? 0.6 : m === 'happy' ? 1.2 : 1 };
          g.active = true;
          g.w = 1;
          a._loco = { kind: 'hop', dir, from: a._x, to: x, hops, hopsDone: 0, resolve, endFacing: 0 };
        } else {
          const L = a._legLen;
          const A = md.stride * tune.stride * D2R;
          const cycleNom = 4 * L * Math.sin(A);
          if (!g.active || g.hop) {
            g.phase = 0.75;
            g.prevQ = [0.75, 0.25];
          }
          g.hop = null;
          // fit the step count so the walk ends at a mid-stance (both legs vertical): frac(end) ∈ {0.25, 0.75}
          const delta = (((0.25 - frac(g.phase)) % 0.5) + 0.5) % 0.5;
          let j = Math.max(0, Math.round(2 * (D / cycleNom - delta)));
          if (j / 2 + delta < 0.25) j += 1;
          const cycle = D / (j / 2 + delta);
          g.sinA = Math.min(Math.sin(34 * D2R), cycle / (4 * L));
          g.dir = dir;
          g.lift = md.lift;
          g.active = true;
          const sp = speed || a._height * 0.5 * md.speed * tune.walkSpeed;
          a._loco = { kind: 'walk', dir, from: a._x, to: x, speed: sp, v: 0, cycle, endPhase: g.phase + D / cycle, resolve, endFacing: 0 };
        }
        a._facing = dir;
      });
    },

    glideTo({ x, y } = {}, { ms = 1000, ease = 'inOut', sway = 0 } = {}) {
      a._wake();
      if (a._glide) a._glide.resolve(false);
      return new Promise((resolve) => {
        a._glide = { x0: a._x, y0: a._y, x1: x ?? a._x, y1: y ?? a._y, t0: a._clock, dur: Math.max(0.001, ms / 1000), ease: ease === 'canopy' ? canopyDescent : easeFn(ease), sway, resolve };
      });
    },

    pose(name, { duration = 450 } = {}) {
      a._wake();
      const p = a._resolvePose(name);
      const pe = a._poseBlend();
      const sign = a._facing || (a._out['view.turn'] < 0 ? -1 : 1);
      for (const key of a._keys) {
        const s = a._S[key];
        s.b0 = s.b0 + (s.b1 - s.b0) * pe;
        s.b1 = a._poseTarget(p, key, sign);
      }
      a._poseName = POSES[name] || (a._def.poses && a._def.poses[name]) ? name : 'idle';
      a._poseT0 = a._clock;
      a._poseDur = Math.max(0.001, duration / 1000);
      a._poseExtras(p, duration);
      return new Promise((res) => a._after(duration, res));
    },

    expression(name) {
      a._setExpression(name);
    },

    setMood(m) {
      if (!MOOD[m]) return;
      a._mood = m;
      a._setExpression(MOOD[m].expr);
      a._wake();
    },

    async play(name, opts = {}) {
      a._wake();
      const fn = (a._def.actions && a._def.actions[name]) || ACTION_LIB[name];
      const exprBefore = a._action ? a._action.exprBefore : a._exprName;
      a._cancelAction();
      if (!fn) return false;
      const token = { cancelled: false };
      a._action = { name, token, exprBefore };
      const ctx = a._makeCtx(token, opts);
      try {
        await fn(ctx, opts);
      } catch (e) {
        if (e !== CANCEL) console.error(e);
      }
      if (token.cancelled) return false;
      a._action = null;
      a._releaseAction(380);
      a._setExpression(exprBefore);
      await new Promise((res) => a._after(380, res));
      return true;
    },

    /** Manually advances the simulation by `ms` of avatar time in 60 Hz steps, independent of timeScale and of
     *  rAF (frame-by-frame inspection, captures in hidden windows). FX animations are advanced alongside. */
    async advance(ms, frameMs = 1000 / 60) {
      let left = ms;
      while (left > 0 && !a._destroyed) {
        const d = Math.min(frameMs, left);
        left -= d;
        a._step(d / 1000);
        for (const an of a._anims) if (an.playState !== 'finished') an.currentTime = (an.currentTime || 0) + d;
        for (let i = 0; i < 12; i++) await null; // let action timelines continue between frames
      }
    },

    stop() {
      a._cancelAction();
      if (a._loco) a._finishLoco(false);
      if (a._glide) {
        a._glide.resolve(false);
        a._glide = null;
      }
    },

    say(ms) {
      a._talkUntil = Math.max(a._talkUntil, a._clock + ms / 1000);
      a._wake();
      return new Promise((res) => a._after(ms, res));
    },

    lookAt(cx, cy) {
      a._wake();
      if (cx == null) {
        a._track = null;
        return;
      }
      const r = a._svg.getBoundingClientRect();
      if (!r.width) return;
      const l = a._anchors.eyeL;
      const rr = a._anchors.eyeR;
      const ex = r.left + (((l[0] + rr[0]) / 2) / 200) * r.width;
      const ey = r.top + (((l[1] + rr[1]) / 2) / 300) * r.height;
      const dx = (cx - ex) / Math.max(120, r.width * 1.6);
      const dy = (cy - ey) / Math.max(120, r.height * 0.9);
      const nx = Math.tanh(dx * 1.4);
      const ny = Math.tanh(dy * 1.4);
      a._track = { x: cx, y: cy };
      a._trackLook = { x: nx, y: ny, tilt: nx * 4 + ny * -1.2, turn: nx * 0.22 };
    },

    fx(name, opts = {}) {
      a._wake();
      if (name === 'clear') {
        for (const h of [...a._fxHandles]) h.stop();
        return { stop() {}, done: Promise.resolve() };
      }
      const h = playFx(a._fxCtx, name, opts);
      a._fxHandles.add(h);
      h.done.then(() => a._fxHandles.delete(h));
      return h;
    },

    setProp(prop = 'none', emoji) {
      a._propId = PROP_META[prop] && prop !== 'umbrella' ? prop : 'none';
      a._emoji = emoji;
      if (!a._propOverride) a._mountProp(a._propId);
      a._bodyBox = null;
      a._wake();
    },

    setColor(hex) {
      a._color = typeof hex === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) ? hex : null;
      a._setColors();
    },

    setAvatar(id, customUrl) {
      const expr = a._exprName;
      a._cancelAction();
      a._build(id, customUrl);
      a._exprName = expr;
      a._applyExpression();
      a._frame(0);
      a._wake();
    },

    setHeight(px) {
      a._height = Math.max(40, Number(px) || 250);
      a._applySize();
      a._resetMotionMemory();
      a._wake();
    },

    anchor(name) {
      const pt = a._anchors[name];
      const k = a._k;
      const top = a._hostH - a._height - a._y;
      if (!pt) return { x: a._x + a._width / 2, y: top };
      const part = a._anchorPart(name);
      const W = part ? a._parts[a._partIdx[part]].w : IDENT;
      const p = mapply(W, pt[0], pt[1]);
      return { x: a._x + p[0] * k, y: top + p[1] * k };
    },

    hitTest(cx, cy) {
      const r = a._svg.getBoundingClientRect();
      if (!r.width) return false;
      const ux = ((cx - r.left) * 200) / r.width;
      const uy = ((cy - r.top) * 300) / r.height;
      const bi = a._partIdx.body;
      const p = bi !== undefined ? mapply(minv(a._parts[bi].w), ux, uy) : [ux, uy];
      if (a._def.id === 'custom') {
        const [x0, y0, w, h] = a._customBox || [0, 0, 200, 300];
        return p[0] >= x0 && p[0] <= x0 + w && p[1] >= y0 && p[1] <= y0 + h;
      }
      if (!a._bodyBox) {
        try {
          a._bodyBox = (bi !== undefined ? a._parts[bi].el : a._svg).getBBox();
          const hi = a._partIdx.head;
          a._headBox = hi !== undefined ? a._parts[hi].el.getBBox() : null;
        } catch {
          return false;
        }
      }
      const b = a._bodyBox;
      if (p[0] < b.x || p[0] > b.x + b.width || p[1] < b.y || p[1] > b.y + b.height) return false;
      const hb = a._headBox;
      if (hb && p[1] < hb.y + hb.height * 0.6) {
        const rx = hb.width / 2;
        const ry = hb.height / 2;
        const nx = (p[0] - (hb.x + rx)) / rx;
        const ny = (p[1] - (hb.y + ry)) / ry;
        if (nx * nx + ny * ny > 1.05) return false;
      }
      return true;
    },

    on(name, cb) {
      if (!a._listeners.has(name)) a._listeners.set(name, new Set());
      a._listeners.get(name).add(cb);
      return () => a._listeners.get(name)?.delete(cb);
    },

    debug(on = true) {
      a._debugOn = !!on;
      a._drawDebug();
    },

    destroy() {
      if (a._destroyed) return;
      api.stop();
      for (const h of [...a._fxHandles]) h.stop();
      a._destroyed = true;
      live.delete(a);
      const timers = a._timers;
      a._timers = [];
      for (const timer of timers) timer.fn();
      if (a._ro) a._ro.disconnect();
      a.el.remove();
      a._fxWorld.remove();
      a._listeners.clear();
    },
  };
  a._api = api;
  api.setColor(opts.color ?? null);
  api.setProp(opts.prop || 'none', opts.emoji);
  if (opts.facing) api.setFacing(opts.facing);
  a._frame(0);
  a._wake();
  return api;
}
