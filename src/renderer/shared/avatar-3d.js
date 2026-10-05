/*
 * Nudgi - 3D avatars (bundled Kai "nova" and imported "me3d")
 * ================================
 * Kai (shared/avatars/models/kai.glb, built by scripts/build-kai.py) and the user's imported Avaturn avatar,
 * brought to life with fully procedural motion. Per-model height and anchors come from glTF scene extras.
 * Same public API as the 2D engine (see avatar-engine.js §5) so the overlay, fx and dev pages work unchanged:
 *
 *   import { createAvatar3D } from './avatar-3d.js';
 *   const av = createAvatar3D(host, { height: 250, prop: 'bottle' });   // returns at once, model loads async
 *   await av.walkTo(400); await av.pose('present'); await av.play('drink');
 *
 * Rendering: one transparent WebGL canvas per avatar inside av.el (three.js r186, vendored, lazily imported so
 * 2D-only pages never parse it). Neutral tone mapping, soft hemisphere fill + warm key + two cool rim lights and a
 * small procedural studio environment for reflections, blob contact shadows on the ground. The camera is a
 * fixed-height "architectural" camera (no keystone) whose frustum is fitted so feet→hair-top = opts.height px.
 *
 * Rig model (everything in Armature/"model" space: +X = avatar's left = screen-right when facing the viewer,
 * +Y up, +Z = the avatar's forward). Every bone gets a model-space delta A (posed world rotation = A · restWorld);
 * deltas compose down the chain, joint positions follow as P = P_parent + A_parent · restOffset. This keeps all
 * pose authoring in intuitive model-space axes:
 *   pitch > 0 bends forward (head down) · yaw > 0 turns toward +X (screen-right) · roll > 0 tilts the top toward −X.
 * Arms and legs are analytic 2-bone IK with hinge frames (the elbow/knee bend plane maps the rest hinge axis onto
 * the solved one, so forearms never twist), hands get a swing/twist wrist solve that keeps the held prop upright
 * (or tilted for drinking) within joint limits, fingers close around the prop's grip cylinder until contact.
 * Walking is a distance-driven IK gait (stance feet are exactly planted, heel strike → roll → toe off), with the
 * hip height derived from leg reach, pelvis/thorax counter-rotation, counter arm swing and turn-in-place steps.
 * All targets are smoothed by closed-form critically damped springs; idle layers add breathing, weight shifts and
 * head micro-motion. There are no morph targets, so "expressions" are expressed through posture.
 */

import { playFx } from './fx.js';
import { canopyDescent, canopySway } from './entrance-motion.js';

export const ME3D_ID = 'me3d';
export const ME3D_INFO = Object.freeze({
  id: ME3D_ID,
  name: 'Me',
  tagline: 'Your 3D avatar',
  colors: { primary: '#38D3EE', secondary: '#1B1E26', accent: '#38D3EE' },
  locomotion: 'walk',
  kind: '3d',
});
// Bundled 3D Kai (built by scripts/build-kai.py); same public id as the 2D Kai it falls back to.
export const KAI3D_INFO = Object.freeze({
  id: 'nova',
  name: 'Kai',
  tagline: 'Hoodie-wearing desk buddy',
  colors: { primary: '#169C8F', secondary: '#26324D', accent: '#2EC5DA' },
  locomotion: 'walk',
  kind: '3d',
});
export const KAI3D_URL = new URL('./avatars/models/kai.glb', import.meta.url).href;

const MODEL_URL = new URL('./avatars/models/me.glb', import.meta.url).href;
const MODEL_H = 1.863; // feet → hair top (m)
const PAD_TOP = 0.52; // canvas headroom above the hair (× height): raised arms, umbrella, hops
const PAD_BOTTOM = 0.06; // below the soles: contact shadow
const WIDTH_F = 0.8; // av.width = height × WIDTH_F (canvas box)
const FOV = 22; // vertical field of view of the canvas frustum (deg)
const CAM_Y = 1.42; // camera height (m), slightly above chest height; horizontal view + lens shift
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const CANCEL = Symbol('nb3d-cancel');

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (v) => v - Math.floor(v);
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export const EASE3D = {
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
const easeFn = (e) => (typeof e === 'function' ? e : EASE3D[e] || EASE3D.inOut);

// Closed-form critically damped spring (stable for any dt). tau ≈ time to cover ~85% of a step.
function spring(s, target, dt, tau) {
  const w = 2 / tau;
  const x = s.v - target;
  const e = Math.exp(-w * dt);
  const tmp = (s.vel + w * x) * dt;
  s.vel = (s.vel - w * tmp) * e;
  s.v = target + (x + tmp) * e;
}

// ------------------------------------------------------------------------------------------------- lazy three.js
let T = null; // THREE namespace once loaded
let GLTFLoaderC = null;
let cloneSkinned = null;
let libP = null;
function loadLib() {
  if (!libP) {
    libP = Promise.all([
      import('../vendor/three/three.module.js'),
      import('../vendor/three/addons/loaders/GLTFLoader.js'),
      import('../vendor/three/addons/utils/SkeletonUtils.js'),
    ]).then(([three, gltf, skel]) => {
      T = three;
      GLTFLoaderC = gltf.GLTFLoader;
      cloneSkinned = skel.clone;
      initScratch();
    });
    libP.catch(() => (libP = null));
  }
  return libP;
}

// scratch objects (allocated once three is available)
let _v1, _v2, _v3, _v4, _v5, _q1, _q2, _q3, _m1, _m2, _e1, _UP, _X, _Y, _Z, _ID;
function initScratch() {
  _v1 = new T.Vector3(); _v2 = new T.Vector3(); _v3 = new T.Vector3(); _v4 = new T.Vector3(); _v5 = new T.Vector3();
  _q1 = new T.Quaternion(); _q2 = new T.Quaternion(); _q3 = new T.Quaternion();
  _m1 = new T.Matrix4(); _m2 = new T.Matrix4(); _e1 = new T.Euler();
  _UP = new T.Vector3(0, 1, 0); _X = new T.Vector3(1, 0, 0); _Y = new T.Vector3(0, 1, 0); _Z = new T.Vector3(0, 0, 1);
  _ID = new T.Quaternion();
}
// model-space rotation from pitch (X), yaw (Y), roll (Z) in degrees: Ry · Rx · Rz
function eulerQ(out, pitch, yaw, roll) {
  return out.setFromEuler(_e1.set(pitch * D2R, yaw * D2R, roll * D2R, 'YXZ'));
}
// rotation mapping the orthonormal pair (a0, b0) onto (a1, b1)
function frameRot(out, a0, b0, a1, b1) {
  const c0 = _v4.crossVectors(a0, b0);
  _m1.makeBasis(a0, b0, c0);
  const c1 = _v5.crossVectors(a1, b1);
  _m2.makeBasis(a1, b1, c1);
  _m2.multiply(_m1.transpose());
  return out.setFromRotationMatrix(_m2);
}
function swingTwist(q, axis, twistOut, swingOut) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  twistOut.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const l = Math.hypot(twistOut.x, twistOut.y, twistOut.z, twistOut.w);
  if (l < 1e-9) twistOut.identity();
  else { twistOut.x /= l; twistOut.y /= l; twistOut.z /= l; twistOut.w /= l; }
  swingOut.copy(twistOut).invert().premultiply(q); // q = swing · twist
}
function quatAngle(q) {
  return 2 * Math.acos(clamp(Math.abs(q.w), 0, 1));
}
function limitQuat(q, maxRad) {
  const a = quatAngle(q);
  if (a > maxRad && a > 1e-6) q.slerp(_ID, 1 - maxRad / a);
  return q;
}

// ------------------------------------------------------------------------------------------------- asset loading
async function fetchArrayBuffer(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.arrayBuffer();
  } catch (err) {
    // file:// pages (Electron) may not support fetch on the file scheme: fall back to XHR
    return await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = () => (x.status === 200 || (x.status === 0 && x.response) ? resolve(x.response) : reject(err));
      x.onerror = () => reject(err);
      x.send();
    });
  }
}

// One parsed template per model URL (Kai and an imported avatar can be on screen together, e.g. in settings).
const templates = new Map();
let templateUsers = 0;
function loadTemplate(modelUrl = MODEL_URL) {
  if (templates.has(modelUrl)) return templates.get(modelUrl);
  const templateP = (async () => {
    await loadLib();
    const buf = await fetchArrayBuffer(modelUrl);
    const loader = new GLTFLoaderC();
    // Decode embedded textures through <img> (img-src allows blob:) instead of fetch()+createImageBitmap, which the
    // pages' CSP (connect-src 'self' file:) would block for blob: URLs.
    loader.register((parser) => {
      parser.textureLoader = new T.TextureLoader(parser.options.manager);
      return { name: 'nb_img_textures' };
    });
    const gltf = await new Promise((res, rej) => loader.parse(buf, modelUrl.replace(/[^/]*$/, ''), res, rej));
    prepareMaterials(gltf.scene);
    // Optional per-model metadata (glTF scene extras): { height, anchors: { name: { bone, p: [x, y, z] } } }.
    // Models without it (an imported Avaturn avatar) use the built-in defaults.
    const meta = gltf.scene.userData && gltf.scene.userData.nudgi ? gltf.scene.userData.nudgi : null;
    return { scene: gltf.scene, rest: buildRest(gltf.scene), meta };
  })();
  templateP.catch((e) => {
    console.error('[avatar-3d] model failed to load', e);
    templates.delete(modelUrl);
  });
  templates.set(modelUrl, templateP);
  return templateP;
}

function prepareMaterials(scene) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // skinned bounds are bind-pose bounds
    const name = o.name || '';
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.map) m.map.anisotropy = 4;
      m.envMapIntensity = 0.85;
    }
    if (/hair/i.test(name)) {
      // Two passes: an alpha-tested opaque core that writes depth (stable sorting), then the soft blended fringe.
      const base = o.material;
      const solid = base.clone();
      solid.transparent = false;
      solid.alphaTest = 0.55;
      solid.depthWrite = true;
      solid.alphaToCoverage = true;
      solid.side = T.DoubleSide;
      const soft = base.clone();
      soft.transparent = true;
      soft.depthWrite = false;
      soft.alphaTest = 0.02;
      soft.side = T.DoubleSide;
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes.position.count;
      g.clearGroups();
      g.addGroup(0, count, 0);
      g.addGroup(0, count, 1);
      o.material = [solid, soft];
      o.renderOrder = 1;
      base.dispose();
    } else if (/glasses_1/i.test(name)) {
      const m = o.material;
      m.transparent = true;
      m.depthWrite = false;
      m.opacity = Math.max(0.12, m.opacity);
      m.envMapIntensity = 1.6;
      o.renderOrder = 2;
    }
  });
}

// Rest-pose data in model (Armature) space.
const B = {
  hips: 'Hips', spine: 'Spine', spine1: 'Spine1', spine2: 'Spine2', neck: 'Neck', head: 'Head',
  shL: 'LeftShoulder', armL: 'LeftArm', foreL: 'LeftForeArm', handL: 'LeftHand',
  shR: 'RightShoulder', armR: 'RightArm', foreR: 'RightForeArm', handR: 'RightHand',
  upL: 'LeftUpLeg', legL: 'LeftLeg', footL: 'LeftFoot', toeL: 'LeftToeBase',
  upR: 'RightUpLeg', legR: 'RightLeg', footR: 'RightFoot', toeR: 'RightToeBase',
};
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];

function buildRest(scene) {
  scene.updateMatrixWorld(true);
  const rest = { bones: {}, order: [] };
  let hips = null;
  scene.traverse((o) => {
    if (o.isBone && o.name === 'Hips') hips = o;
  });
  if (!hips) throw new Error('avatar-3d: no Hips bone');
  const visit = (b) => {
    const p = new T.Vector3();
    const q = new T.Quaternion();
    const s = new T.Vector3();
    b.matrixWorld.decompose(p, q, s);
    rest.bones[b.name] = { p, q, s: s.x, parent: b.parent && b.parent.isBone ? b.parent.name : null, lq: b.quaternion.clone() };
    rest.order.push(b.name);
    for (const c of b.children) if (c.isBone) visit(c);
  };
  visit(hips);
  const R = rest.bones;
  const P = (n) => R[n].p;
  const dir = (a, b) => new T.Vector3().subVectors(P(b), P(a)).normalize();
  const ortho = (n, r) => n.clone().addScaledVector(r, -n.dot(r)).normalize();
  const limb = (a, b, c, hinge) => {
    const r1 = dir(a, b);
    const r2 = dir(b, c);
    return { a, b, c, l1: P(a).distanceTo(P(b)), l2: P(b).distanceTo(P(c)), r1, r2, n1: ortho(hinge, r1), n2: ortho(hinge, r2) };
  };
  rest.armL = limb(B.armL, B.foreL, B.handL, new T.Vector3(0, -1, 0));
  rest.armR = limb(B.armR, B.foreR, B.handR, new T.Vector3(0, 1, 0));
  rest.legL = limb(B.upL, B.legL, B.footL, new T.Vector3(1, 0, 0));
  rest.legR = limb(B.upR, B.legR, B.footR, new T.Vector3(1, 0, 0));
  rest.hipJointY = P(B.upL).y;
  rest.ankleY = (P(B.footL).y + P(B.footR).y) / 2;
  rest.ballOff = new T.Vector3().subVectors(P(B.toeL), P(B.footL)); // ankle → ball of the foot
  rest.ballOff.x = 0;
  rest.heelOff = new T.Vector3(0, -rest.ankleY, -0.052); // ankle → heel contact
  for (const side of ['L', 'R']) rest[`hand${side}`] = buildHand(R, side);
  return rest;
}

// Hand-space (rest hand frame, metres) finger chains for grip solving and per-joint local rotations.
function buildHand(R, side) {
  const pre = side === 'L' ? 'Left' : 'Right';
  const hand = R[`${pre}Hand`];
  const Winv = hand.q.clone().invert();
  const toHand = (p) => p.clone().sub(hand.p).applyQuaternion(Winv);
  const qHand = (q) => Winv.clone().multiply(q);
  const chains = [];
  for (const f of [...FINGERS, 'Thumb']) {
    const names = [1, 2, 3].map((i) => `${pre}Hand${f}${i}`);
    if (!names.every((n) => R[n])) continue;
    const pts = names.map((n) => toHand(R[n].p));
    const last = pts[2].clone().sub(pts[1]);
    const tip = pts[2].clone().addScaledVector(last.normalize(), (f === 'Thumb' ? 0.026 : 0.021) * (f === 'Pinky' ? 0.85 : 1));
    pts.push(tip);
    const W0 = names.map((n) => qHand(R[n].q));
    const Wp0inv = [new T.Quaternion(), W0[0].clone().invert(), W0[1].clone().invert()];
    const joints = names.map((n, i) => ({ name: n, W0: W0[i], Wp0inv: Wp0inv[i] }));
    chains.push({ finger: f, thumb: f === 'Thumb', pts, joints });
  }
  const p = (n) => toHand(R[`${pre}Hand${n}`].p);
  const knIdx = p('Index1');
  const knPinky = p('Pinky1');
  const lateral = knIdx.clone().sub(knPinky).normalize(); // pinky → index (bottom → top of a fist)
  const thumb = chains.find((c) => c.thumb);
  if (thumb) {
    const t = thumb.pts[3].clone().sub(thumb.pts[0]).normalize();
    thumb.flexAxis = t.clone().cross(new T.Vector3(0, 0, 1)).normalize();
    thumb.oppSign = 1;
    // pick the opposition direction that swings the thumb tip toward the palm side (+Z)
    const tipZ = (sgn) => thumb.pts[3].clone().sub(thumb.pts[0]).applyAxisAngle(new T.Vector3(0, 1, 0), sgn * 0.4).z;
    thumb.oppSign = tipZ(1) > tipZ(-1) ? 1 : -1;
  }
  return {
    side,
    W0: hand.q.clone(),
    scale: hand.s,
    chains,
    lateral,
    palmZ: 0.034,
    cx: (knIdx.x + knPinky.x) / 2,
    knY: (knIdx.y + knPinky.y) / 2,
  };
}

// FK of one finger chain in hand space for angles [a1, a2, a3] → points [p1, p2, p3, tip]
function chainDeltas(chain, ang, out) {
  // returns the three hand-space delta quaternions (as if parent at rest)
  if (chain.thumb) {
    const opp = _q3.setFromAxisAngle(_Y, chain.oppSign * ang[3]);
    out[0].setFromAxisAngle(chain.flexAxis, -ang[0] * 0.6).premultiply(opp);
    out[1].setFromAxisAngle(chain.flexAxis, -ang[1]);
    out[2].setFromAxisAngle(chain.flexAxis, -ang[2]);
  } else {
    out[0].setFromAxisAngle(_X, ang[0]);
    out[1].setFromAxisAngle(_X, ang[1]);
    out[2].setFromAxisAngle(_X, ang[2]);
  }
  return out;
}
const _dq = [null, null, null];
function chainPoints(chain, ang, out) {
  if (!_dq[0]) for (let i = 0; i < 3; i++) _dq[i] = new T.Quaternion();
  chainDeltas(chain, ang, _dq);
  const A = _q2.identity();
  out[0].copy(chain.pts[0]);
  for (let k = 0; k < 3; k++) {
    A.multiply(_dq[k]);
    out[k + 1].copy(chain.pts[k + 1]).sub(chain.pts[k]).applyQuaternion(A).add(out[k]);
  }
  return out;
}
function segLineDist(a, b, c, d) {
  // distance between segment ab and the infinite line through c with unit direction d
  const ab = _v1.subVectors(b, a);
  const ac = _v2.subVectors(a, c);
  const abP = _v3.copy(ab).addScaledVector(d, -ab.dot(d));
  const acP = ac.addScaledVector(d, -ac.dot(d));
  const den = abP.lengthSq();
  const t = den > 1e-12 ? clamp(-acP.dot(abP) / den, 0, 1) : 0;
  return acP.addScaledVector(abP, t).length();
}
// Close each joint (proximal → distal) until any distal segment touches the grip cylinder.
function solveGrip(hand, cyl) {
  const pts = [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()];
  const shapes = {};
  for (const ch of hand.chains) {
    const ang = ch.thumb ? [0, 0, 0, cyl.opp ?? 0.5] : [0, 0, 0];
    const max = ch.thumb ? [55 * D2R, 60 * D2R, 75 * D2R] : [88 * D2R, 102 * D2R, 72 * D2R];
    const R = cyl.r + (ch.thumb ? 0.010 : 0.0085);
    const touching = (k) => {
      chainPoints(ch, ang, pts);
      for (let s = k; s < 3; s++) if (segLineDist(pts[s], pts[s + 1], cyl.c, cyl.d) <= R) return true;
      return false;
    };
    for (let k = 0; k < 3; k++) {
      if (touching(k)) continue;
      const step = 2 * D2R;
      let a = 0;
      while (a < max[k]) {
        a = Math.min(max[k], a + step);
        ang[k] = a;
        if (touching(k)) {
          ang[k] = Math.max(0, a - step * 0.5);
          break;
        }
      }
    }
    shapes[ch.finger] = ang.slice();
  }
  return shapes;
}
const RELAXED = { Index: [10, 16, 8], Middle: [15, 21, 10], Ring: [19, 25, 12], Pinky: [23, 29, 14], Thumb: [10, 12, 10, 14] };
const OPEN = { Index: [2, 3, 1], Middle: [2, 3, 1], Ring: [3, 4, 2], Pinky: [4, 5, 2], Thumb: [0, 2, 2, 4] };
const degShape = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((d) => d * D2R)]));

// ------------------------------------------------------------------------------------------------- tables
// Channels: [idle value, spring tau (s)]. Hand targets are wrist positions relative to each shoulder joint in chest
// space (metres); poles are elbow directions in chest space; angles in degrees.
const CH = {
  rootY: [0, 0.04], hipX: [0, 0.14], hipY: [0, 0.09], hipZ: [0, 0.14],
  hipPitch: [0, 0.16], hipYaw: [0, 0.16], hipRoll: [0, 0.16],
  spinePitch: [1.5, 0.16], spineYaw: [0, 0.16], spineRoll: [0, 0.16],
  chestPitch: [-1.5, 0.16], chestYaw: [0, 0.16], chestRoll: [0, 0.16],
  neckPitch: [0, 0.13], neckYaw: [0, 0.13], neckRoll: [0, 0.13],
  headPitch: [0, 0.11], headYaw: [0, 0.11], headRoll: [0, 0.11],
  shLUp: [-6, 0.13], shLFwd: [2, 0.13], shRUp: [-6, 0.13], shRFwd: [2, 0.13],
  turnC: [0, 0.35], facingAmt: [1, 0.2], yawOff: [0, 0.2],
  hLx: [0.08, 0.12], hLy: [-0.47, 0.12], hLz: [0.065, 0.12],
  hRx: [-0.08, 0.12], hRy: [-0.47, 0.12], hRz: [0.065, 0.12],
  pLx: [0.38, 0.15], pLy: [-0.05, 0.15], pLz: [-1, 0.15],
  pRx: [-0.38, 0.15], pRy: [-0.05, 0.15], pRz: [-1, 0.15],
  wLf: [0, 0.1], wLd: [0, 0.1], wLt: [0, 0.1], wRf: [0, 0.1], wRd: [0, 0.1], wRt: [0, 0.1],
  gripR: [1, 0.09], fistL: [0, 0.09], fistR: [0, 0.09], openL: [0, 0.09], openR: [0, 0.09],
  aTilt: [0, 0.13], aRoll: [0, 0.13], solveR: [1, 0.15], palmW: [0, 0.15], palmX: [0, 0.15], palmY: [0, 0.15], palmZ: [1, 0.15],
  propVis: [1, 0.07], umbrellaOpen: [1, 0.09],
  stance: [0.1, 0.2], fLz: [0, 0.12], fRz: [0, 0.12], fLy: [0, 0.08], fRy: [0, 0.08], fLp: [0, 0.1], fRp: [0, 0.1],
  breath: [1, 0.5], sway: [1, 0.5],
};
const CH_NAMES = Object.keys(CH);
const MIRROR = new Set(['yawOff', 'hipX', 'hipYaw', 'hipRoll', 'spineYaw', 'spineRoll', 'chestYaw', 'chestRoll', 'neckYaw', 'neckRoll', 'headYaw', 'headRoll']);

const POSES = {
  idle: {},
  // The presenting pose: the bottle raised beside the chest, shown proudly; chest up, slight head tilt toward it,
  // body turned a touch toward the screen centre.
  present: {
    turnC: 1, chestPitch: -5, spinePitch: 0.5, headRoll: 4.5, headPitch: -2.5, neckPitch: -1,
    shRUp: -3, shRFwd: 3,
    hRx: -0.07, hRy: -0.235, hRz: 0.27, pRx: -0.55, pRy: -1, pRz: -0.4,
    aTilt: -7, aRoll: 5, palmZ: 1, palmW: 0,
    hLx: 0.085, hLy: -0.465, hLz: 0.075,
  },
  wave: {
    hLx: 0.25, hLy: 0.3, hLz: 0.1, pLx: 0.85, pLy: -1, pLz: -0.15, openL: 1, wLt: -55, wLf: -12, shLUp: 2,
    headRoll: -4, chestPitch: -2,
  },
  shrug: {
    shLUp: 9, shRUp: 9, shLFwd: 4, shRFwd: 4,
    hLx: 0.2, hLy: -0.3, hLz: 0.2, hRx: -0.2, hRy: -0.3, hRz: 0.2,
    pLx: 0.25, pLy: -1, pLz: -0.45, pRx: -0.25, pRy: -1, pRz: -0.45,
    openL: 1, wLt: 75, wLf: -18, wRt: -40,
    headRoll: 8, headPitch: 3, neckPitch: 2, chestPitch: 1,
  },
  sad: {
    spinePitch: 7, chestPitch: 7.5, neckPitch: 12, headPitch: 10, hipZ: -0.012,
    shLUp: -10, shRUp: -10, shLFwd: 10, shRFwd: 10,
    hLx: 0.045, hLy: -0.485, hLz: 0.12, hRx: -0.045, hRy: -0.485, hRz: 0.12,
    pLx: 0.25, pRx: -0.25,
    aTilt: 16, aRoll: -6, solveR: 0.55, breath: 0.85, sway: 0.6,
  },
  happy: {
    chestPitch: -6.5, spinePitch: -0.5, headPitch: -5, shLUp: -3, shRUp: -3, shLFwd: -2, shRFwd: -2,
    hLx: 0.12, hLy: -0.43, hLz: 0.085, hRx: -0.12, hRy: -0.43, hRz: 0.1, openL: 0.35,
  },
  think: {
    ikL: { anchor: 'chin', off: [0.006, -0.03, 0.05] }, pLx: 0.25, pLy: -1, pLz: -0.2, fistL: 0.55,
    headRoll: -6, headYaw: 9, headPitch: -6, neckPitch: -2, chestPitch: -1,
    hRx: -0.06, hRy: -0.42, hRz: 0.12,
  },
  peek: {
    mirror: true, facingAmt: 0.42, spineRoll: -9, chestRoll: -4, headRoll: -9, hipX: 0.02, hipRoll: 3,
    hLx: 0.12, hLy: -0.42, hLz: 0.1, hRx: -0.1, hRy: -0.44, hRz: 0.1, openL: 0.3,
  },
  umbrella: {
    propOverride: 'umbrella',
    hRx: -0.1, hRy: 0.21, hRz: 0.12, pRx: -1, pRy: 0.75, pRz: -0.15, aRoll: -5, aTilt: -2,
    umbrellaOpen: 1, sway: 0.2,
    hLx: 0.15, hLy: -0.4, hLz: 0.11, openL: 0.5, headPitch: -6,
  },
};
export const POSE_NAMES_3D = Object.keys(POSES);

const MOOD = {
  neutral: { speed: 1, step: 1, lift: 1, arm: 1, bob: 1, lean: 3, breathHz: 0.24, breath: 1, sway: 1, post: {} },
  happy: { speed: 1.16, step: 1.05, lift: 1.25, arm: 1.3, bob: 1.35, lean: 2.2, breathHz: 0.3, breath: 1.08, sway: 1.1, post: { chestPitch: -2.5, headPitch: -2 } },
  sad: { speed: 0.6, step: 0.8, lift: 0.55, arm: 0.35, bob: 0.75, lean: 5.5, breathHz: 0.15, breath: 0.85, sway: 0.6, post: { neckPitch: 5, headPitch: 4, spinePitch: 2.5, shLFwd: 4, shRFwd: 4, shLUp: -3, shRUp: -3 } },
};

// Expressions have no face here: they are short posture accents layered on top of everything.
const EXPRESSIONS = {
  neutral: {},
  happy: { chestPitch: -3, headPitch: -3, headRoll: 2 },
  sad: { headPitch: 7, neckPitch: 3, shLFwd: 4, shRFwd: 4 },
  surprised: { headPitch: -6, neckPitch: -3, shLUp: 6, shRUp: 6, chestPitch: -3 },
  closed: { headPitch: 3 },
  love: { headRoll: 7, chestPitch: -3, headPitch: -2 },
};

// Anchors: [bone, model-space rest point]. Avatar-side names (_l/_r); public names follow the 2D convention.
const ANCHORS = {
  top: [B.head, [0, 1.863, -0.02]],
  mouth: [B.head, [0, 1.623, 0.091]],
  chin: [B.head, [0, 1.578, 0.072]],
  nose: [B.head, [0, 1.68, 0.108]],
  eye_l: [B.head, [0.032, 1.708, 0.088]],
  eye_r: [B.head, [-0.032, 1.708, 0.088]],
  ear_l: [B.head, [0.094, 1.69, -0.012]],
  ear_r: [B.head, [-0.094, 1.69, -0.012]],
  chest: [B.spine2, [0, 1.36, 0.14]],
  belly: [B.spine, [0, 1.1, 0.15]],
};

// Props (metres). grip: cylinder radius the fingers close around; spout: distance from the grip centre to the
// mouth/speaker point along the prop's axis; tilt: drinking tilt (deg, top toward the face).
const PROP3D = {
  bottle: { grip: 0.034, spout: 0.16, drinkTilt: 112, water: true, level: 0.74 },
  glass: { grip: 0.036, spout: 0.075, drinkTilt: 98, water: true, level: 0.7 },
  mug: { grip: 0.009, spout: 0.07, drinkTilt: 72 },
  phone: { grip: 0.011, spout: 0.06, drinkTilt: 0, flat: true },
  umbrella: { grip: 0.012, spout: 0, drinkTilt: 0 },
  sprite: { grip: 0.028, spout: 0.02, drinkTilt: 0, sprite: true },
  none: { grip: 0.03, spout: 0, drinkTilt: 0, empty: true },
};
const SPRITE_EMOJI = { pill: '💊', dumbbell: '🏋️', glasses: '👓', book: '📖', emoji: '💧' };
const PROP_IDS = ['bottle', 'glass', 'phone', 'mug', 'pill', 'dumbbell', 'glasses', 'book', 'emoji', 'none'];

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
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) for (const a of all3d) a._wake();
  });
}
const all3d = new Set();

function ensureStyles() {
  if (document.querySelector('link[data-nb-engine]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./fx.css', import.meta.url).href;
  link.dataset.nbEngine = '';
  document.head.appendChild(link);
}

let failedForSession = false;
/** False once WebGL or the model failed in this session (callers fall back to a 2D buddy). */
export function avatar3DAvailable() {
  if (failedForSession) return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------- the avatar
class Avatar3D {
  constructor(host, opts) {
    if (!host) throw new Error('createAvatar3D: host element required');
    ensureStyles();
    this.host = host;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this._opts = opts;
    this._onFail = typeof opts.onFail === 'function' ? opts.onFail : null;
    this._modelUrl = opts.modelUrl;
    this._info = opts.avatarId === 'nova' ? KAI3D_INFO : ME3D_INFO;
    this._ts = opts.timeScale ?? 1;
    this._clock = 0;
    this._height = Math.max(40, Number(opts.height) || 360);
    this._x = Number(opts.x) || 0;
    this._y = 0;
    this._mood = MOOD[opts.mood] ? opts.mood : 'neutral';
    this._facing = 0;
    this._listeners = new Map();
    this._timers = [];
    this._anims = new Set();
    this._fxHandles = new Set();
    this._destroyed = false;
    this._loaded = new Promise((resolve) => { this._loadResolve = resolve; });
    this._walkRequest = 0;
    this._ready = false;
    this._failed = false;
    this._propId = 'none';
    this._emoji = '';
    this._propOverride = null;
    this._exprName = 'neutral';
    this._talkUntil = 0;
    this._track = null;
    this._action = null;
    this._loco = null;
    this._glide = null;
    this._sleeping = true;

    this.el = document.createElement('div');
    this.el.className = 'nb-avatar nb-avatar-3d';
    Object.assign(this.el.style, { position: 'absolute', left: '0px', bottom: '0px', overflow: 'visible', pointerEvents: 'none' });
    this._canvas = document.createElement('canvas');
    this._canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this._canvas.style, { position: 'absolute', left: '0px', display: 'block', opacity: '0', transition: 'opacity 420ms ease-out, filter 600ms ease' });
    this._fxLocal = document.createElement('div');
    this._fxLocal.className = 'nb-fx-layer';
    this.el.append(this._canvas, this._fxLocal);
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

    this._initChannels();
    this._applySize();
    this._fxCtx = this._makeFxCtx();
    all3d.add(this);
    this._load();
  }

  // ---------------------------------------------------------------------------------------------- setup
  _initChannels() {
    this._S = {};
    for (const name of CH_NAMES) {
      const [v, tau] = CH[name];
      this._S[name] = { v, vel: 0, b0: v, b1: v, act: null, dyn: 0, tau, rest: v };
    }
    this._F = {}; // final per-frame values (channels + layers)
    for (const name of CH_NAMES) this._F[name] = this._S[name].v;
    this._poseName = 'idle';
    this._pose = POSES.idle;
    this._poseT0 = 0;
    this._poseDur = 0;
    this._poseSign = 1;
    this._ik = { L: null, R: null };
    this._poseIk = { L: null, R: null };
    this._yaw = { v: 0, vel: 0 };
    this._lookS = { yaw: { v: 0, vel: 0 }, pitch: { v: 0, vel: 0 } };
    this._micro = { yaw: { v: 0, vel: 0 }, pitch: { v: 0, vel: 0 }, roll: { v: 0, vel: 0 }, t: 0, ty: 0, tp: 0, tr: 0 };
    this._weight = { v: 0, vel: 0, t: 3, side: 0 };
    this._expr = {};
    this._exprS = {};
    for (const k of CH_NAMES) this._exprS[k] = { v: 0, vel: 0 };
    this._breathPh = Math.random() * TAU;
    this._swayT = Math.random() * 10;
    this._gait = { phase: 0, w: 0, active: false, C: 1.2, beta: 0.6, lift: 0.09, bobTab: null, dir: 1, A: 0, v: 0 };
    this._turn = { phase: 0, w: 0, lastYaw: 0 };
    this._air = { v: 0, vel: 0 };
    this._liquid = { level: 0.74, target: 0.74 };
    this._frameN = 0;
  }

  async _load() {
    let tpl;
    try {
      if (failedForSession) throw new Error('3D disabled for this session');
      tpl = await loadTemplate(this._modelUrl || (await window.nudge?.getState?.())?.meta?.avatarModelUrl || MODEL_URL);
      if (this._destroyed) return;
      templateUsers++;
      this._initGL(tpl);
    } catch (err) {
      if (this._destroyed) return;
      console.error('[avatar-3d] unavailable, falling back', err);
      this._fail(err);
      return;
    }
    try {
      await this._renderer.compileAsync(this._scene, this._camera);
    } catch {
      /* compileAsync is an optimisation */
    }
    if (this._destroyed) return;
    this._ready = true;
    this._loadResolve(true);
    this._step(0, true);
    this._render();
    requestAnimationFrame(() => {
      if (this._destroyed) return;
      this._canvas.style.opacity = '1';
    });
    this._emit('ready', {});
    this._wake();
  }

  _fail(err) {
    this._failed = true;
    this._loadResolve(false);
    // never leave the director hanging: settle everything that waits on the clock
    const timers = this._timers;
    this._timers = [];
    for (const t of timers) t.fn();
    if (this._action) this._action.token.cancelled = true;
    if (this._loco) this._finishLoco(false);
    if (this._glide) {
      this._glide.resolve(false);
      this._glide = null;
    }
    this._emit('error', { error: err });
    if (this._onFail) this._onFail(err);
  }

  _initGL(tpl) {
    const renderer = new T.WebGLRenderer({ canvas: this._canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'default' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.NeutralToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.localClippingEnabled = true;
    this._renderer = renderer;
    this._canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this._destroyed || this._failed) return;
      failedForSession = true;
      this._fail(new Error('WebGL context lost'));
    });

    const scene = new T.Scene();
    this._scene = scene;
    const pm = new T.PMREMGenerator(renderer);
    const envScene = makeStudio();
    this._envRT = pm.fromScene(envScene, 0.035);
    disposeTree(envScene);
    pm.dispose();
    scene.environment = this._envRT.texture;
    scene.environmentIntensity = 0.55;

    const hemi = new T.HemisphereLight(0xdfe8ff, 0x3b3330, 0.85);
    const key = new T.DirectionalLight(0xfff0e2, 2.5);
    key.position.set(-2.4, 3.4, 3.6);
    const rim = new T.DirectionalLight(0xa4dcff, 3.2);
    rim.position.set(2.6, 2.6, -3.2);
    const rim2 = new T.DirectionalLight(0xc6d8ff, 1.3);
    rim2.position.set(-2.8, 1.8, -2.6);
    const fill = new T.DirectionalLight(0xffffff, 0.45);
    fill.position.set(1.8, 0.6, 3);
    scene.add(hemi, key, rim, rim2, fill);

    this._camera = new T.PerspectiveCamera(FOV, 1, 0.1, 50);
    this._root = new T.Group();
    scene.add(this._root);
    const model = cloneSkinned(tpl.scene);
    this._model = model;
    this._root.add(model);
    this._rest = tpl.rest;
    const meta = tpl.meta || {};
    this._modelH = Number(meta.height) > 0.5 ? Number(meta.height) : MODEL_H;
    this._anchorDefs = meta.anchors
      ? Object.fromEntries(Object.entries(meta.anchors).filter(([, v]) => v && v.bone && Array.isArray(v.p)).map(([k, v]) => [k, [v.bone, v.p]]))
      : ANCHORS;
    // Tintable cloth (the buddy colour setting): per-instance material copies so other instances keep their colour.
    this._tint = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = mats.map((m) => {
        if (!m || !/^kai_(primary|rib)/.test(m.name || '')) return m;
        const c = m.clone();
        this._tint.push({ m: c, base: c.color.clone(), rib: /rib/.test(m.name) });
        return c;
      });
      o.material = Array.isArray(o.material) ? out : out[0];
    });
    if (this._color) this._applyTint(this._color);
    this._bones = {};
    model.traverse((o) => {
      if (o.isBone) this._bones[o.name] = o;
    });
    this._initRig();
    this._initShadows();
    this._propRoot = new T.Group();
    this._bones[B.handR].add(this._propRoot);
    this._mountProp();
    this._applySize();
  }

  _initRig() {
    const R = this._rest.bones;
    this._A = {};
    this._P = {};
    for (const n of this._rest.order) {
      this._A[n] = new T.Quaternion();
      this._P[n] = R[n].p.clone();
    }
    this._W = {}; // posed model-space world rotations of driven bones
    this._anchorsM = {}; // latest model-space anchor points
    for (const k of Object.keys(this._anchorDefs)) this._anchorsM[k] = new T.Vector3().fromArray(this._anchorDefs[k][1]);
    this._anchorsM.handL = R[B.handL].p.clone();
    this._anchorsM.handR = R[B.handR].p.clone();
    this._anchorsM.ground = new T.Vector3(0, 0, 0.015);
    this._spoutM = new T.Vector3();
    this._wristR = R[B.handR].p.clone();
    this._handShapes = { L: null, R: null };
    this._fingerAng = { L: {}, R: {} };
    for (const side of ['L', 'R']) {
      const h = this._rest[`hand${side}`];
      h.fist = h.fist || solveGrip(h, { c: new T.Vector3(h.cx, h.knY - 0.022, h.palmZ + 0.012), d: new T.Vector3(1, 0, 0), r: 0.012, opp: 0.55 });
    }
    this._footG = { L: new T.Vector3(), R: new T.Vector3() };
    this._footPitch = { L: 0, R: 0 };
    this._tmpQ = new T.Quaternion();
    this._tmpQ2 = new T.Quaternion();
    this._tmpV = new T.Vector3();
  }

  _initShadows() {
    const tex = blobTexture();
    this._shadowTex = tex;
    const mk = (opacity) => {
      const m = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity, toneMapped: false, color: 0x070b14 }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = -1;
      this._scene.add(m);
      return m;
    };
    this._shadow = { body: mk(0.42), L: mk(0.5), R: mk(0.5) };
  }

  _applyTint(hex) {
    for (const t of this._tint || []) {
      if (!hex) t.m.color.copy(t.base);
      else {
        t.m.color.set(hex);
        if (t.rib) t.m.color.multiplyScalar(0.78);
      }
    }
  }

  _applySize() {
    const h = this._height;
    this._k = h / (this._modelH || MODEL_H); // px per metre
    this._width = Math.round(h * WIDTH_F);
    this._padSide = this._throwCanvas ? Math.round(h * 1.1) : 0;
    this._cw = this._width + this._padSide * 2;
    this._ch = Math.round(h * (1 + PAD_TOP + PAD_BOTTOM));
    this._padTop = Math.round(h * PAD_TOP);
    this.el.style.width = `${this._width}px`;
    this.el.style.height = `${h}px`;
    Object.assign(this._canvas.style, { left: `${-this._padSide}px`, top: `${-this._padTop}px`, width: `${this._cw}px`, height: `${this._ch}px` });
    if (this._renderer) {
      this._renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this._renderer.setSize(this._cw, this._ch, false);
      this._fitCamera();
    }
    this._writeEl();
  }

  _fitCamera() {
    const k = this._k;
    const spanH = this._ch / k;
    const spanW = this._cw / k;
    const d = this._throwCameraDistance || spanH / 2 / Math.tan((FOV * D2R) / 2);
    const yBot = -(this._ch - this._padTop - this._height) / k;
    const yTop = yBot + spanH;
    const cam = this._camera;
    cam.position.set(0, CAM_Y, d);
    cam.rotation.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    const n = cam.near;
    const s = n / d;
    cam.projectionMatrix.makePerspective((-spanW / 2) * s, (spanW / 2) * s, (yTop - CAM_Y) * s, (yBot - CAM_Y) * s, n, cam.far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this._camD = d;
  }

  _writeEl() {
    const str = `translate3d(${this._x.toFixed(2)}px, ${(-this._y).toFixed(2)}px, 0)`;
    if (str !== this._elStr) {
      this.el.style.transform = str;
      this._elStr = str;
    }
  }

  // ---------------------------------------------------------------------------------------------- props
  _mountProp() {
    if (!this._propRoot) return;
    for (const c of [...this._propRoot.children]) {
      this._propRoot.remove(c);
      disposeTree(c);
    }
    const id = this._propOverride || this._propId;
    const kind = PROP3D[id] ? id : id === 'none' ? 'none' : 'sprite';
    const meta = PROP3D[kind];
    this._propKind = kind;
    this._propMeta = meta;
    const built = buildProp(kind, kind === 'sprite' ? (id === 'emoji' ? this._emoji || SPRITE_EMOJI.emoji : SPRITE_EMOJI[id] || this._emoji || '✨') : '');
    if (built) {
      const materials = new Set();
      built.group.traverse(o => { if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m); });
      built.fades = [...materials].map(material => ({ material, opacity: material.opacity }));
      for (const { material } of built.fades) {
        if (!material.transparent) { material.transparent = true; material.needsUpdate = true; }
      }
    }
    this._prop = built;
    const hand = this._rest.handR;
    // grip frame in hand space: origin on the cylinder axis, +Y along the prop axis (pinky → index), +Z = palm normal
    const r = meta.grip;
    const c = new T.Vector3(hand.cx, hand.knY - 0.02, hand.palmZ + r);
    if (meta.flat) c.set(hand.cx, hand.knY - 0.012, hand.palmZ + 0.006);
    if (meta.sprite || meta.empty) c.set(hand.cx, hand.knY - 0.012, hand.palmZ + 0.04);
    const axis = hand.lateral.clone();
    const zAxis = new T.Vector3(0, 0, 1).addScaledVector(axis, -axis.z).normalize();
    const xAxis = new T.Vector3().crossVectors(axis, zAxis);
    const q = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(xAxis, axis, zAxis));
    this._gripLocal = { c, axis, q };
    const s = 1 / hand.scale;
    this._propRoot.position.copy(c).multiplyScalar(s);
    this._propRoot.quaternion.copy(q);
    this._propRoot.scale.setScalar(s);
    if (built) this._propRoot.add(built.group);
    // finger shape around this prop
    const cyl = meta.flat
      ? { c: new T.Vector3(hand.cx, hand.knY + 0.026, hand.palmZ + 0.012), d: axis, r: 0.006, opp: 0.25 }
      : meta.sprite || meta.empty
        ? { c: new T.Vector3(hand.cx, hand.knY - 0.012, hand.palmZ + 0.03), d: axis, r: 0.03, opp: 0.35 }
        : { c, d: axis, r, opp: id === 'mug' ? 0.2 : 0.55 };
    this._handShapes.R = solveGrip(hand, cyl);
    this._liquid.level = this._liquid.target = meta.level ?? 0;
  }

  _reserveThrowFrame() {
    if (this._throwCanvas) return;
    this._throwCameraDistance = this._camD;
    this._throwCanvas = true;
    this._applySize();
  }

  _tossUmbrella(dir) {
    if (!this._prop || this._propKind !== 'umbrella') return Promise.resolve(false);
    if (this._thrown) this._clearThrown();
    this._reserveThrowFrame();
    const object = this._prop.group;
    this._root.updateMatrixWorld(true);
    // attach preserves the complete world transform: the umbrella cannot teleport on release.
    this._scene.attach(object);
    const promise = new Promise(resolve => {
      this._thrown = { object, velocity: new T.Vector3(dir * 4.8, 1, 0), age: 0,
        spin: new T.Vector3(0.18, 0.4, -dir).normalize(), resolve, cameraDistance: this._camD };
    });
    this._prop = null;
    this._propKind = 'none';
    this._propMeta = PROP3D.none;
    this._S.propVis.v = this._F.propVis = 0;
    this._S.propVis.vel = 0;
    this._setPose('idle', 500);
    this._applySize();
    this._emit('throw', { dir });
    return promise;
  }

  _updateThrown(dt) {
    const thrown = this._thrown;
    if (!thrown || dt <= 0) return;
    thrown.age += dt;
    // Gravity is integrated analytically for the frame; spin continues after the hand releases.
    thrown.object.position.addScaledVector(thrown.velocity, dt);
    thrown.object.position.y -= 0.5 * 9.81 * dt * dt;
    thrown.velocity.y -= 9.81 * dt;
    thrown.object.quaternion.premultiply(new T.Quaternion().setFromAxisAngle(thrown.spin, 3.4 * dt));
    thrown.object.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(thrown.object);
    const inv = this._root.matrixWorld.clone().invert();
    const points=[];
    for(const x of [box.min.x,box.max.x]) for(const y of [box.min.y,box.max.y]) for(const z of [box.min.z,box.max.z]) {
      const p=this._project(new T.Vector3(x,y,z).applyMatrix4(inv),{});
      points.push({x:p.x+this._x,y:p.y+this._elTop()});
    }
    const outside = Math.min(...points.map(p=>p.x)) > this._hostW + 8 || Math.max(...points.map(p=>p.x)) < -8 || Math.min(...points.map(p=>p.y)) > this._hostH + 8;
    if (outside || thrown.age > 2) this._clearThrown();
  }

  _clearThrown() {
    const thrown = this._thrown;
    if (!thrown && !this._throwCanvas) return;
    if (thrown) {
      thrown.object.removeFromParent();
      disposeTree(thrown.object);
      this._thrown = null;
    }
    this._throwCanvas = false;
    this._throwCameraDistance = null;
    this._applySize();
    thrown?.resolve(true);
  }

  _updateProp(dt) {
    const p = this._prop;
    const vis = clamp(this._F.propVis, 0, 1);
    if (this._propRoot) this._propRoot.visible = vis > 0.01 && !!p;
    if (!p) return;
    // Held objects retain their size; visibility fades never inflate a bottle or break its grip.
    p.group.scale.setScalar(1);
    for (const fade of p.fades || []) fade.material.opacity = fade.opacity * vis;
    if (p.canopy) {
      const open = clamp(this._F.umbrellaOpen, 0, 1);
      // Fold fabric toward the shaft; grip and shaft remain at their physical size.
      p.canopy.scale.set(0.045 + 0.955 * open, 1.8 - 0.8 * open, 0.045 + 0.955 * open);
      p.canopy.position.y = -0.28 * (1 - open);
    }
    if (p.water) {
      // keep the liquid level horizontal in world space (clipping plane through the fill point)
      const L = this._liquid;
      L.level += (L.target - L.level) * (1 - Math.exp(-dt * 3));
      p.group.updateWorldMatrix(true, false);
      const m = p.group.matrixWorld;
      const base = _v1.set(0, p.water.y0, 0).applyMatrix4(m);
      const top = _v2.set(0, p.water.y1, 0).applyMatrix4(m);
      const fillPt = _v3.copy(base).lerp(top, clamp(L.level, 0, 1));
      // tilted containers: the liquid runs toward the low end - lower the plane a little with the tilt
      const axis = _v4.subVectors(top, base).normalize();
      const tilt = Math.acos(clamp(axis.y, -1, 1));
      fillPt.y -= Math.sin(tilt) * 0.012;
      p.water.plane.normal.set(0, -1, 0);
      p.water.plane.constant = fillPt.y;
      p.water.mesh.visible = L.level > 0.02;
    }
    if (p.steam) {
      for (const s of p.steam) {
        s.t = (s.t + dt / s.dur) % 1;
        s.sprite.position.set(Math.sin((s.t + s.ph) * 7) * 0.008, 0.11 + s.t * 0.11, 0);
        s.sprite.material.opacity = Math.sin(Math.PI * s.t) * 0.35;
        const sc = 0.03 + s.t * 0.05;
        s.sprite.scale.set(sc, sc, sc);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- poses
  _poseBlend() {
    return this._poseDur > 0 ? EASE3D.inOut(clamp((this._clock - this._poseT0) / this._poseDur, 0, 1)) : 1;
  }

  _baseOf(name) {
    const s = this._S[name];
    const pe = this._poseBlend();
    const b1 = typeof s.b1 === 'function' ? s.b1() : s.b1;
    let v = s.b0 + (b1 - s.b0) * pe;
    const mp = MOOD[this._mood].post[name];
    if (mp) v += mp;
    return v;
  }

  _setPose(name, ms) {
    const p = POSES[name] || POSES.idle;
    const pe = this._poseBlend();
    const sign = p.mirror ? (this._facing || 1) : 1;
    for (const ch of CH_NAMES) {
      const s = this._S[ch];
      const b1 = typeof s.b1 === 'function' ? s.b1() : s.b1;
      s.b0 = s.b0 + (b1 - s.b0) * pe;
      let v = p[ch] !== undefined ? p[ch] : s.rest;
      if (sign < 0 && MIRROR.has(ch)) v = -v;
      s.b1 = v;
    }
    for (const side of ['L', 'R']) {
      const spec = p[`ik${side}`] || null;
      this._poseIk[side] = spec;
      if (spec) {
        const keys = side === 'L' ? ['hLx', 'hLy', 'hLz'] : ['hRx', 'hRy', 'hRz'];
        keys.forEach((k, i) => (this._S[k].b1 = () => this._evalSpec(side, spec)[i]));
      }
    }
    this._poseName = POSES[name] ? name : 'idle';
    this._pose = p;
    this._poseT0 = this._clock;
    this._poseDur = Math.max(0.001, ms / 1000);
    const over = p.propOverride || null;
    if (over !== this._propOverride) {
      this._propOverride = over;
      this._mountProp();
    }
  }

  // hand-target spec → [x, y, z] relative to the side's shoulder joint, in chest space
  _evalSpec(side, spec) {
    if (Array.isArray(spec)) return spec;
    if (!this._ready || !this._anchorsM) return side === 'L' ? [0.08, -0.47, 0.06] : [-0.08, -0.47, 0.06];
    if (spec._f === this._frameN && spec._side === side) return spec._r;
    const pt = _v1.copy(this._anchorPointM(spec.anchor || 'mouth'));
    if (spec.off) {
      const defs = this._anchorDefs || ANCHORS;
      const bone = (defs[spec.anchor] && defs[spec.anchor][0]) || B.spine2;
      pt.add(_v2.fromArray(spec.off).applyQuaternion(this._A[bone]));
    }
    if (spec.spout) pt.sub(_v2.subVectors(this._spoutM, this._wristR));
    const sh = this._P[side === 'L' ? B.armL : B.armR];
    pt.sub(sh).applyQuaternion(_q1.copy(this._A[B.spine2]).invert());
    spec._f = this._frameN;
    spec._side = side;
    spec._r = [pt.x, pt.y, pt.z];
    return spec._r;
  }

  _anchorPointM(name) {
    return this._anchorsM[name] || this._anchorsM.chest;
  }

  _setExpression(name) {
    this._exprName = EXPRESSIONS[name] ? name : 'neutral';
    this._expr = EXPRESSIONS[this._exprName];
  }

  // ---------------------------------------------------------------------------------------------- frame
  _wake() {
    if (this._destroyed || !this._ready) return;
    this._sleeping = false;
    wakeTicker(this);
  }

  _frame(dtReal) {
    if (this._destroyed) return;
    if (!this._ready) {
      live.delete(this);
      return;
    }
    this._step(dtReal * this._ts);
    if (this._visible()) this._render();
    this._maybeSleep();
  }

  _visible() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (this.el.style.visibility === 'hidden') return false;
    return !this._offscreen();
  }

  _offscreen() {
    return this._x + this._width < -40 || this._x > this._hostW + 40 || this._y > this._hostH + this._height * 1.6;
  }

  _maybeSleep() {
    const idle = !this._loco && !this._glide && !this._action && !this._timers.length && this._ts !== 0;
    if (idle && (this._offscreen() || this.el.style.visibility === 'hidden' || document.hidden)) {
      this._sleeping = true;
      live.delete(this);
    }
  }

  _render() {
    if (!this._renderer) return;
    this._renderer.render(this._scene, this._camera);
  }

  _fireTimers(now) {
    if (!this._timers.length) return;
    const due = this._timers.filter((t) => t.at <= now);
    if (!due.length) return;
    this._timers = this._timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  }

  _after(ms, fn) {
    const t = { at: this._clock + ms / 1000, fn };
    if (this._failed || this._destroyed) {
      fn();
      return () => {};
    }
    this._timers.push(t);
    this._wake();
    return () => {
      const i = this._timers.indexOf(t);
      if (i >= 0) this._timers.splice(i, 1);
    };
  }

  _step(dt, init = false) {
    if (dt > 0) this._clock += dt;
    this._frameN++;
    const now = this._clock;
    this._fireTimers(now);
    this._updateLoco(dt);
    // channels: action tween ?? pose blend → spring
    const F = this._F;
    for (const name of CH_NAMES) {
      const s = this._S[name];
      let tgt;
      if (s.act) {
        const a = s.act;
        const t = a.dur > 0 ? clamp((now - a.t0) / a.dur, 0, 1) : 1;
        const to = a.release ? this._baseOf(name) : typeof a.to === 'function' ? a.to() : a.to;
        tgt = a.from + (to - a.from) * a.ease(t);
        if (a.release && t >= 1) s.act = null;
      } else tgt = this._baseOf(name);
      tgt += s.dyn;
      if (init) {
        s.v = tgt;
        s.vel = 0;
      } else if (dt > 0) spring(s, tgt, dt, s.tau);
      F[name] = s.v;
    }
    this._ikTargets(now);
    this._addLayers(dt, now);
    if (this._bones) {
      this._solve(dt);
      this._updateProp(dt);
      this._updateThrown(dt);
      this._updateShadows();
    }
  }

  // explicit hand IK tweens (action layer) override the scalar hand channels
  _ikTargets(now) {
    for (const side of ['L', 'R']) {
      const ik = this._ik[side];
      if (!ik) continue;
      const keys = side === 'L' ? ['hLx', 'hLy', 'hLz'] : ['hRx', 'hRy', 'hRz'];
      const t = ik.dur > 0 ? clamp((now - ik.t0) / ik.dur, 0, 1) : 1;
      const e = ik.ease(t);
      const to = ik.spec ? this._evalSpec(side, ik.spec) : keys.map((k) => this._baseOf(k));
      const arc = Math.sin(Math.PI * e) * ik.arc;
      for (let i = 0; i < 3; i++) {
        const tgt = ik.from[i] + (to[i] - ik.from[i]) * e + (i === 2 ? arc : i === 1 ? arc * 0.25 : 0);
        const s = this._S[keys[i]];
        if (!ik.spec && t >= 1) continue;
        s.v = s.v + (tgt - s.v) * (1 - Math.exp(-(1 / 0.045) * Math.max(0.001, this._lastDt || 0.016)));
        s.vel = 0;
        this._F[keys[i]] = s.v;
      }
      if (!ik.spec && t >= 1) this._ik[side] = null;
    }
  }

  _addLayers(dt, now) {
    const F = this._F;
    this._lastDt = dt;
    const md = MOOD[this._mood];
    // expression accents (springy)
    for (const k of CH_NAMES) {
      const es = this._exprS[k];
      const tgt = this._expr[k] || 0;
      if (tgt === 0 && es.v === 0 && es.vel === 0) continue;
      if (dt > 0) spring(es, tgt, dt, 0.18);
      if (Math.abs(es.v) < 1e-4 && Math.abs(es.vel) < 1e-4 && tgt === 0) {
        es.v = 0;
        es.vel = 0;
      }
      F[k] += es.v;
    }
    const g = this._gait;
    const walking = g.w;
    const still = 1 - walking;
    // breathing
    this._breathPh += dt * TAU * md.breathHz;
    const b = Math.sin(this._breathPh) * F.breath * md.breath;
    F.chestPitch -= 1.25 * b;
    F.spinePitch -= 0.35 * b;
    F.shLUp += 0.8 * b;
    F.shRUp += 0.8 * b;
    F.headPitch += 0.5 * b;
    // idle sway + weight shifts (standing only)
    this._swayT += dt;
    const sw = F.sway * md.sway * still * (1 - this._air.v);
    const W = this._weight;
    W.t -= dt;
    if (W.t <= 0) {
      W.t = rand(4.5, 9);
      const r = Math.random();
      W.side = r < 0.38 ? -1 : r < 0.76 ? 1 : 0;
    }
    if (dt > 0) spring(W, W.side, dt, 0.9);
    F.hipX += (0.008 * Math.sin(this._swayT * TAU * 0.11) + 0.02 * W.v) * sw;
    F.hipRoll += (0.6 * Math.sin(this._swayT * TAU * 0.11 + 1.3) + 2.0 * W.v) * sw;
    F.hipY -= 0.005 * Math.abs(W.v) * sw;
    F.spineRoll -= 1.6 * W.v * sw;
    F.chestRoll -= 0.4 * W.v * sw;
    F.headRoll += 0.6 * W.v * sw;
    // head micro-motion
    const mc = this._micro;
    mc.t -= dt;
    if (mc.t <= 0) {
      mc.t = rand(1.8, 4.2);
      mc.ty = rand(-3.5, 3.5);
      mc.tp = rand(-2, 2.2);
      mc.tr = rand(-1.6, 1.6);
    }
    if (dt > 0) {
      spring(mc.yaw, mc.ty * still, dt, 0.55);
      spring(mc.pitch, mc.tp * still, dt, 0.55);
      spring(mc.roll, mc.tr * still, dt, 0.55);
    }
    const lookOn = this._track ? 0.35 : 1;
    F.headYaw += mc.yaw.v * lookOn;
    F.headPitch += mc.pitch.v * lookOn;
    F.headRoll += mc.roll.v;
    // cursor look (neck 35 %, head 65 %, a little chest)
    const tl = this._trackLook || { yaw: 0, pitch: 0 };
    const busyHead = this._action && this._action.ownsHead ? 0.25 : 1;
    if (dt > 0) {
      spring(this._lookS.yaw, this._track ? tl.yaw * busyHead : 0, dt, 0.17);
      spring(this._lookS.pitch, this._track ? tl.pitch * busyHead : 0, dt, 0.17);
    }
    const ly = this._lookS.yaw.v;
    const lp = this._lookS.pitch.v;
    F.neckYaw += ly * 0.35;
    F.headYaw += ly * 0.55;
    F.chestYaw += ly * 0.1;
    F.neckPitch += lp * 0.35;
    F.headPitch += lp * 0.65;
    F.headRoll += ly * -0.08;
    // talking: subtle head bob
    if (now < this._talkUntil) {
      const env = clamp((this._talkUntil - now) / 0.25, 0, 1);
      F.headPitch += (1.5 * Math.sin(now * TAU * 4.1) + 0.8 * Math.sin(now * TAU * 2.3 + 1)) * env;
      F.headRoll += 0.7 * Math.sin(now * TAU * 1.7) * env;
      F.chestPitch += 0.4 * Math.sin(now * TAU * 2.3) * env;
    }
    // head leads body turns
    const yawErr = this._yawTarget() - this._yaw.v;
    F.neckYaw += clamp(yawErr * 0.3, -24, 24);
    // airborne (drop entrance / long falls): legs dangle
    // y also includes the director's 10px ground margin. Only real altitude is airborne.
    const altitude = Math.max(0, this._y - 12) / this._k + Math.max(0, F.rootY);
    const airT = this._propKind === 'umbrella' ? smooth(altitude / 0.6) : clamp(altitude / 0.12, 0, 1);
    if (dt > 0) spring(this._air, airT, dt, 0.18);
    // gait layers
    if (walking > 0.001) this._gaitLayers(F, walking, md);
  }

  _yawTarget() {
    const F = this._F;
    let y = this._facing * 90 * F.facingAmt + F.yawOff;
    if (F.turnC > 0.001 && this._hostW > 0) {
      const cx = this._x + this._width / 2;
      const off = clamp((cx - this._hostW / 2) / (this._hostW / 2), -1, 1);
      y += -off * 15 * F.turnC;
    }
    return y;
  }

  // ---------------------------------------------------------------------------------------------- locomotion
  _updateLoco(dt) {
    const g = this._gait;
    // facing yaw spring
    if (dt > 0) {
      const prev = this._yaw.v;
      spring(this._yaw, this._yawTarget(), dt, 0.2);
      const dy = this._yaw.v - prev;
      const tr = this._turn;
      const vel = Math.abs(dy) / dt;
      const want = g.w < 0.3 && this._air.v < 0.5 && vel > 35 ? clamp(vel / 160, 0.35, 1) : 0;
      tr.w += (want - tr.w) * (1 - Math.exp(-dt * 10));
      if (tr.w > 0.02) {
        const before = Math.floor(tr.phase);
        tr.phase += Math.abs(dy) / 46;
        if (Math.floor(tr.phase) !== before && tr.w > 0.3) this._emit('step', { foot: Math.floor(tr.phase) % 2 ? 'R' : 'L', turn: true });
      } else if (tr.w <= 0.02) {
        tr.phase = Math.round(tr.phase);
      }
    }
    if (this._glide) this._updateGlide(dt);
    const L = this._loco;
    if (!L) {
      if (g.active) {
        g.w = Math.max(0, g.w - dt * 4.5);
        if (g.w <= 0) g.active = false;
      }
      return;
    }
    if (dt <= 0) return;
    const yawErr = Math.abs(this._yawTarget() - this._yaw.v);
    const allowed = clamp(1 - (yawErr - 22) / 40, 0, 1);
    const remain = Math.abs(L.to - this._x);
    const accel = L.speed / 0.32;
    const decel = L.speed / 0.4;
    const vMax = Math.min(L.speed * allowed, Math.sqrt(2 * decel * remain) + 3);
    L.v = L.v < vMax ? Math.min(vMax, L.v + accel * dt) : vMax;
    let step = L.v * dt;
    let arrived = false;
    if (step >= remain - 0.05) {
      step = remain;
      arrived = true;
    }
    this._x += L.dir * step;
    const before = g.phase;
    g.phase += step / this._k / g.C;
    g.v = L.v / this._k;
    const weightTarget = clamp(L.v / (0.3 * L.speed), 0, 1);
    g.w += (weightTarget - g.w) * (1 - Math.exp(-dt / 0.1));
    if (g.w > 0.999 && weightTarget === 1) g.w = 1;
    this._stepEvents(before, g.phase);
    this._writeEl();
    if (arrived) {
      this._x = L.to;
      g.phase = L.endPhase;
      this._writeEl();
      this._finishLoco(true);
    }
  }

  _stepEvents(a, b) {
    if (this._gait.w < 0.3) return;
    for (const [foot, off] of [['L', 0], ['R', 0.5]]) {
      if (Math.floor(a + off) !== Math.floor(b + off)) this._emit('step', { foot });
    }
  }

  _finishLoco(ok) {
    const L = this._loco;
    if (!L) return;
    this._loco = null;
    this._facing = L.endFacing;
    L.resolve(ok);
  }

  _startWalk(x, speedPx, mood) {
    const md = MOOD[MOOD[mood] ? mood : this._mood];
    const dist = x - this._x;
    const dir = Math.sign(dist);
    const D = Math.abs(dist) / this._k; // metres
    const g = this._gait;
    const speed = speedPx || this._height * 0.5 * md.speed;
    const v = speed / this._k;
    const stepLen = clamp((0.36 + 0.27 * v) * md.step, 0.3, 0.86);
    const C0 = stepLen * 2;
    const beta = mood === 'sad' || this._mood === 'sad' ? 0.65 : 0.6;
    if (!g.active || g.w < 0.05) g.phase = beta / 2; // L mid-stance, R mid-swing
    g.beta = beta;
    // fit so the walk ends at a mid-stance (frac(phase) ≡ β/2 mod ½)
    const delta = ((((beta / 2 - frac(g.phase)) % 0.5) + 0.5) % 0.5);
    let j = Math.max(0, Math.round(2 * (D / C0 - delta)));
    if (j / 2 + delta < 0.25) j += 1;
    g.C = D / (j / 2 + delta);
    g.lift = 0.095 * md.lift * clamp(0.6 + 0.4 * v, 0.6, 1.2);
    g.heel = 14 * clamp(md.lift, 0.6, 1.2);
    g.toe = 34 * clamp(md.lift, 0.55, 1.15);
    g.armA = 0.15 * md.arm * clamp(0.5 + 0.5 * v, 0.5, 1.3);
    g.bobMood = md.bob;
    g.lean = md.lean + clamp((v - 1) * 2.5, -1, 3);
    g.mood = MOOD[mood] ? mood : this._mood;
    g.active = true;
    g.bobTab = this._bobTable(g);
    this._facing = dir;
    return { dir, speed, endPhase: g.phase + D / g.C };
  }

  // hip height (relative to rest) along the cycle so the stance legs always reach the ground
  _bobTable(g) {
    const rest = this._rest;
    const reach = (rest.legL.l1 + rest.legL.l2) * 0.965;
    const hipH = rest.hipJointY;
    const N = 48;
    const tab = new Float32Array(N + 1);
    const tmp = { z: 0, y: 0, psi: 0 };
    for (let i = 0; i <= N; i++) {
      const ph = i / N;
      let drop = 0;
      for (const off of [0, 0.5]) {
        const f = frac(ph + off);
        gaitFoot(f, g, tmp);
        const ank = this._anklePos(tmp, _v1.set(0, 0, 0));
        const dz = ank.z - 0.015;
        const maxH = ank.y + Math.sqrt(Math.max(0, reach * reach - dz * dz - 0.0001));
        const want = maxH - hipH;
        // A smooth conservative minimum switches support between legs without a hip jerk.
        const h = clamp(0.5 + 0.5 * (want - drop) / 0.025, 0, 1);
        drop = lerp(want, drop, h) - 0.025 * h * (1 - h);
      }
      tab[i] = drop;
    }
    const out = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const a = tab[(i + N - 1) % N];
      const b = tab[i % N];
      const c = tab[(i + 1) % N];
      out[i] = Math.min(b, (a + 2 * b + c) / 4) - 0.006;
    }
    return out;
  }

  _bobAt(phase) {
    const tab = this._gait.bobTab;
    if (!tab) return 0;
    const N = tab.length - 1;
    const f = frac(phase) * N;
    const i = Math.floor(f);
    return lerp(tab[i], tab[Math.min(N, i + 1)], f - i);
  }

  // ankle position for a foot ground reference + pitch (heel / ball pivots)
  _anklePos(foot, out) {
    const rest = this._rest;
    const psi = foot.psi * D2R;
    const pivot = psi > 0 ? rest.ballOff : rest.heelOff;
    // ankle = ground + pivot + Rx(psi) · (−pivot); rest ankle height above ground
    const px = 0;
    const py = pivot.y + rest.ankleY;
    const pz = pivot.z;
    const ry = -pivot.y;
    const rz = -pivot.z;
    const c = Math.cos(psi);
    const s = Math.sin(psi);
    // rotation about X: y' = y c − z s ; z' = y s + z c  (positive psi = heel up)
    const y2 = ry * c - rz * s;
    const z2 = ry * s + rz * c;
    out.set(out.x + px, foot.y + py + y2, foot.z + pz + z2);
    return out;
  }

  _gaitLayers(F, w, md) {
    const g = this._gait;
    const ph = g.phase;
    const c = Math.cos(TAU * ph);
    F.hipY += this._bobAt(ph) * w * g.bobMood;
    if (g.mood === 'happy') F.hipY += 0.01 * Math.max(0, Math.sin(TAU * 2 * ph - 0.6)) * w;
    F.hipYaw += -5 * c * w;
    F.spineYaw += 4.5 * c * w;
    F.neckYaw += -2 * c * w;
    const swingL = this._swingW(frac(ph));
    const swingR = this._swingW(frac(ph + 0.5));
    F.hipRoll += 2.4 * (swingR - swingL) * w;
    F.spineRoll -= 1.4 * (swingR - swingL) * w;
    F.hipX += 0.012 * (swingR - swingL) * w;
    F.spinePitch += g.lean * w;
    F.neckPitch -= g.lean * 0.45 * w;
    F.headPitch += 0.8 * Math.sin(TAU * 2 * ph) * w;
    // counter arm swing: L hand forward while the R leg is forward
    const A = g.armA * w;
    const zl = -A * c;
    const zr = A * c * (this._propKind !== 'none' && this._propKind !== 'sprite' ? 0.6 : 1);
    F.hLz += zl;
    F.hRz += zr;
    F.hLy += 0.25 * zl * zl / Math.max(0.05, g.armA) + 0.12 * Math.max(0, zl);
    F.hRy += 0.25 * zr * zr / Math.max(0.05, g.armA) + 0.12 * Math.max(0, zr);
    F.hLx -= 0.03 * Math.max(0, zl);
    F.hRx += 0.03 * Math.max(0, zr);
  }

  _swingW(f) {
    const b = this._gait.beta;
    return f < b ? 0 : Math.sin(Math.PI * (f - b) / (1 - b));
  }

  _updateGlide() {
    const gl = this._glide;
    const t = clamp((this._clock - gl.t0) / gl.dur, 0, 1);
    const e = gl.ease(t);
    const pendulum = canopySway(t);
    const kpx = this._height / 300;
    const swayX = gl.sway ? pendulum.offset * gl.sway : 0;
    const prevX = this._x;
    this._x = lerp(gl.x0, gl.x1, e) + swayX * kpx;
    this._y = lerp(gl.y0, gl.y1, e);
    const sr = this._S.hipRoll;
    if (gl.sway) {
      sr.dyn = pendulum.roll * Math.min(3, gl.sway * 0.18);
      this._S.spineRoll.dyn = -sr.dyn * 0.4;
      this._S.aRoll.dyn = -sr.dyn * 0.35;
    }
    // sliding along the ground: drive the gait by distance so the feet step instead of skating
    const dx = Math.abs(this._x - prevX);
    const g = this._gait;
    if (this._y < 2 && this._air.v < 0.3 && Math.abs(gl.x1 - gl.x0) > 8 && !this._loco) {
      if (!g.active || !g.bobTab) {
        g.phase = g.beta / 2;
        g.C = clamp(Math.abs(gl.x1 - gl.x0) / this._k, 0.5, 1.1);
        g.lift = 0.07;
        g.heel = 10;
        g.toe = 26;
        g.armA = 0.08;
        g.bobMood = 0.8;
        g.lean = 2;
        g.mood = this._mood;
        g.bobTab = this._bobTable(g);
      }
      g.active = true;
      const before = g.phase;
      g.phase += dx / this._k / g.C;
      g.w = Math.min(1, g.w + 0.2);
      this._stepEvents(before, g.phase);
    }
    this._writeEl();
    if (t >= 1) {
      this._x = gl.x1;
      this._y = gl.y1;
      sr.dyn = this._S.spineRoll.dyn = this._S.aRoll.dyn = 0;
      this._glide = null;
      this._writeEl();
      gl.resolve(true);
    }
  }

  // ---------------------------------------------------------------------------------------------- skeleton solve
  _solve(dt) {
    const F = this._F;
    const R = this._rest.bones;
    const A = this._A;
    const P = this._P;
    const rest = this._rest;

    // root: facing yaw + vertical hop offset
    this._root.rotation.y = this._yaw.v * D2R;
    this._root.position.y = F.rootY;

    // hips
    eulerQ(A[B.hips], F.hipPitch, F.hipYaw, F.hipRoll);
    P[B.hips].copy(R[B.hips].p).add(_v1.set(F.hipX, F.hipY, F.hipZ));

    // spine chain (distributed), chest extras on Spine2
    const sp = [[B.spine, 0.3], [B.spine1, 0.35], [B.spine2, 0.35]];
    for (const [n, wgt] of sp) {
      const extra = n === B.spine2;
      eulerQ(_q1, F.spinePitch * wgt + (extra ? F.chestPitch : 0), F.spineYaw * wgt + (extra ? F.chestYaw : 0), F.spineRoll * wgt + (extra ? F.chestRoll : 0));
      this._chain(n, _q1);
    }
    this._chain(B.neck, eulerQ(_q1, F.neckPitch, F.neckYaw, F.neckRoll));
    this._chain(B.head, eulerQ(_q1, F.headPitch, F.headYaw, F.headRoll));
    // clavicles: raise about Z, protract about Y (mirrored)
    this._chain(B.shL, eulerQ(_q1, 0, -F.shLFwd, F.shLUp));
    this._chain(B.shR, eulerQ(_q1, 0, F.shRFwd, -F.shRUp));

    // anchors on the head/chest for this frame
    for (const [name, [bone, pt]] of Object.entries(this._anchorDefs)) {
      const a = this._anchorsM[name];
      a.fromArray(pt).sub(R[bone].p).applyQuaternion(A[bone]).add(P[bone]);
    }

    // arms
    this._solveArm('L');
    this._solveArm('R');

    // legs
    this._solveLegs(dt);

    // write local rotations for every bone that has a parent bone
    for (const n of rest.order) {
      const r = R[n];
      const W = (this._W[n] ||= new T.Quaternion());
      W.copy(A[n]).multiply(r.q);
    }
    for (const n of rest.order) {
      const bone = this._bones[n];
      if (!bone) continue;
      if (n.includes('Hand') && /Thumb|Index|Middle|Ring|Pinky/.test(n)) continue; // fingers handled below
      const r = R[n];
      if (!r.parent) {
        bone.quaternion.copy(this._W[n]);
        bone.position.copy(P[n]);
      } else {
        _q1.copy(this._W[r.parent]).invert().multiply(this._W[n]);
        if (dt > 0 && [B.armL, B.foreL, B.handL, B.armR, B.foreR, B.handR].includes(n)) {
          // A final joint-speed limit handles IK singularities without visible arm snaps.
          const angle = bone.quaternion.angleTo(_q1);
          const alpha = Math.min(1 - Math.exp(-dt / 0.025), angle > 1e-6 ? 500 * D2R * dt / angle : 1);
          bone.quaternion.slerp(_q1, alpha).normalize();
        } else bone.quaternion.copy(_q1);
      }
    }
    this._writeFingers('L');
    this._writeFingers('R');

    // Anchors and contact probes follow the rendered joints, including the IK transition filter.
    this._root.updateMatrixWorld(true);
    _m1.copy(this._root.matrixWorld).invert();
    for (const side of ['L', 'R']) {
      const hand = rest[`hand${side}`];
      const foreN = side === 'L' ? B.foreL : B.foreR;
      const handN = side === 'L' ? B.handL : B.handR;
      this._bones[foreN].getWorldPosition(P[foreN]).applyMatrix4(_m1);
      this._bones[handN].getWorldPosition(P[handN]).applyMatrix4(_m1);
      _v1.set(hand.cx, hand.knY - 0.02, hand.palmZ + 0.02).multiplyScalar(1 / hand.scale);
      this._anchorsM[`hand${side}`].copy(this._bones[handN].localToWorld(_v1)).applyMatrix4(_m1);
    }
    if (this._propRoot && this._propMeta) {
      _v1.set(0, this._propMeta.spout || 0, 0);
      this._spoutM.copy(this._propRoot.localToWorld(_v1)).applyMatrix4(_m1);
      this._wristR.copy(P[B.handR]);
    }

    // ground anchor follows the hips
    this._anchorsM.ground.set(P[B.hips].x, 0, P[B.hips].z);
  }

  // follow-the-parent delta composition: A = A_parent · D ; P = P_parent + A_parent · restOffset
  _chain(name, D) {
    const R = this._rest.bones;
    const r = R[name];
    const pa = r.parent;
    const A = this._A[name];
    A.copy(this._A[pa]).multiply(D);
    this._P[name].copy(r.p).sub(R[pa].p).applyQuaternion(this._A[pa]).add(this._P[pa]);
    return A;
  }

  _follow(name) {
    const R = this._rest.bones;
    const r = R[name];
    const pa = r.parent;
    this._A[name].copy(this._A[pa]);
    this._P[name].copy(r.p).sub(R[pa].p).applyQuaternion(this._A[pa]).add(this._P[pa]);
  }

  _solveArm(side) {
    const F = this._F;
    const rest = this._rest;
    const limb = side === 'L' ? rest.armL : rest.armR;
    const A = this._A;
    const P = this._P;
    const chestQ = A[B.spine2];
    this._follow(limb.a);
    const s = P[limb.a];
    const hx = side === 'L' ? F.hLx : F.hRx;
    const hy = side === 'L' ? F.hLy : F.hRy;
    const hz = side === 'L' ? F.hLz : F.hRz;
    const t = _v1.set(hx, hy, hz).applyQuaternion(chestQ).add(s);
    const pole = _v2.set(side === 'L' ? F.pLx : F.pRx, side === 'L' ? F.pLy : F.pRy, side === 'L' ? F.pLz : F.pRz).applyQuaternion(chestQ);
    const res = this._ik2(s, t, pole, limb);
    // upper arm + forearm
    frameRot(A[limb.a], limb.r1, limb.n1, res.d1, this._smoothHingeNormal(side + 'upper', res.d1, res.n));
    frameRot(A[limb.b], limb.r2, limb.n2, res.d2, this._smoothHingeNormal(side + 'lower', res.d2, res.n));
    P[limb.b].copy(res.e);
    P[limb.c].copy(res.t);
    // hand: follow the forearm, then the wrist solve
    const hand = rest[`hand${side}`];
    const Ah = A[limb.c];
    Ah.copy(A[limb.b]);
    const f = _v3.copy(res.d2);
    if (side === 'R' && this._propKind && !this._propMeta.empty) {
      this._wristSolve(Ah, A[limb.b], f, hand);
    } else if (side === 'R' && this._wristCorrection) {
      this._applyWristRotation(Ah, A[limb.b], f, _ID);
    }
    // manual wrist offsets (hand-local axes): flex about X, deviation about Z, twist about Y
    const wf = side === 'L' ? F.wLf : F.wRf;
    const wd = side === 'L' ? F.wLd : F.wRd;
    const wt = side === 'L' ? F.wLt : F.wRt;
    if (wf || wd || wt) {
      eulerQ(_q1, wf, wt, wd); // local X, Y, Z
      // A' = A · W0 · Rlocal · W0⁻¹
      _q2.copy(hand.W0).multiply(_q1).multiply(_q3.copy(hand.W0).invert());
      Ah.multiply(_q2);
      // a share of the twist travels up the forearm (no twist bones in this rig)
      if (wt) A[limb.b].premultiply(_q1.setFromAxisAngle(f, wt * 0.35 * D2R * (side === 'L' ? 1 : -1) * 0));
    }
    // palm centre anchor + spout (R)
    const palm = _v4.set(hand.cx, hand.knY - 0.02, hand.palmZ + 0.02).applyQuaternion(hand.W0).applyQuaternion(Ah).add(P[limb.c]);
    this._anchorsM[`hand${side}`].copy(palm);
    if (side === 'R' && this._gripLocal) {
      const gl = this._gripLocal;
      const meta = this._propMeta;
      const sp = _v4.copy(gl.axis).multiplyScalar(meta.spout || 0).add(gl.c).applyQuaternion(hand.W0).applyQuaternion(Ah).add(P[limb.c]);
      this._spoutM.copy(sp);
      this._wristR.copy(P[limb.c]);
    }
  }

  // Retain the elbow's bend frame across near-straight IK configurations. Smoothing only the
  // twist about the limb direction preserves the exact elbow and hand positions.
  _smoothHingeNormal(key, direction, desired) {
    this._hingeNormals ||= {};
    const previous = this._hingeNormals[key] ||= desired.clone();
    previous.addScaledVector(direction, -previous.dot(direction));
    if (previous.lengthSq() < 1e-6) previous.copy(desired);
    previous.normalize();
    const angle = Math.atan2(direction.dot(_v1.crossVectors(previous, desired)), clamp(previous.dot(desired), -1, 1));
    const dt = this._lastDt || 0;
    const step = clamp(angle * (1 - Math.exp(-dt / 0.09)), -180 * D2R * dt, 180 * D2R * dt);
    return previous.applyAxisAngle(direction, step).normalize();
  }

  _applyWristRotation(Ah, Afore, axis, target) {
    const filtered = this._wristCorrection ||= new T.Quaternion();
    const dt = this._lastDt || 0;
    const angle = filtered.angleTo(target);
    const alpha = Math.min(1 - Math.exp(-dt / 0.055), angle > 1e-6 ? 360 * D2R * dt / angle : 1);
    filtered.slerp(target, alpha).normalize();
    Ah.premultiply(filtered);
    swingTwist(filtered, axis, this._tmpQ2, _q3);
    Afore.premultiply(this._tmpQ2.slerp(_ID, 0.6));
  }

  // Swing/twist wrist solve so the prop's axis approaches the desired direction within joint limits.
  _wristSolve(Ah, Afore, f, hand) {
    const F = this._F;
    const w = clamp(F.solveR, 0, 1);
    if (w <= 0.001) return;
    const gl = this._gripLocal;
    // current world orientation of the hand following the forearm: H0 = Afore · W0
    const H0 = _q1.copy(Afore).multiply(hand.W0);
    const gw = _v4.copy(gl.axis).applyQuaternion(H0);
    // desired prop axis: up, tilted toward the face (about chest X) and rolled outward (about Z)
    const desired = _v5.set(0, 1, 0);
    desired.applyQuaternion(eulerQ(_q2, -F.aTilt, 0, F.aRoll));
    desired.applyQuaternion(this._A[B.hips]);
    let Q;
    if (F.palmW > 0.01) {
      // full frame: prop axis + palm normal (e.g. a phone screen facing the camera / the ear)
      const palm0 = _v1.set(0, 0, 1).applyQuaternion(H0);
      const pd = _v2.set(F.palmX, F.palmY, F.palmZ).normalize();
      pd.addScaledVector(desired, -pd.dot(desired)).normalize();
      const p0 = palm0.addScaledVector(gw, -palm0.dot(gw)).normalize();
      const pdMix = _v3.copy(p0).lerp(pd, clamp(F.palmW, 0, 1)).normalize();
      Q = frameRot(this._tmpQ, gw, p0, desired, pdMix.addScaledVector(desired, -pdMix.dot(desired)).normalize());
    } else {
      Q = this._tmpQ.setFromUnitVectors(gw, desired);
      // prefer twisting the forearm over bending the wrist: re-express as twist about f + limited swing
    }
    const twist = this._tmpQ2;
    const swing = _q3;
    swingTwist(Q, f, twist, swing);
    this._wristProbe = { twist: quatAngle(twist) / D2R, swing: quatAngle(swing) / D2R };
    // limits: wrist swing 55°; overhead pronation is shared with the forearm.
    limitQuat(twist, (this._propKind === 'umbrella' ? 150 : 95) * D2R);
    if (this._propKind === 'umbrella') {
      const shared = new T.Quaternion().copy(_ID).slerp(twist, 0.6);
      Afore.premultiply(shared);
      Ah.copy(Afore);
      twist.multiply(shared.invert());
    }
    limitQuat(swing, 55 * D2R);
    Q.copy(swing).multiply(twist);
    if (w < 1) Q.slerp(_ID, 1 - w);
    this._applyWristRotation(Ah, Afore, f, Q);
  }

  // analytic 2-bone IK with a hinge frame; returns elbow e, wrist t (clamped), directions and hinge n
  _ik2(s, target, pole, limb) {
    const out = this._ikOut || (this._ikOut = { e: new T.Vector3(), t: new T.Vector3(), d1: new T.Vector3(), d2: new T.Vector3(), n: new T.Vector3() });
    const l1 = limb.l1;
    const l2 = limb.l2;
    const dv = _v3.subVectors(target, s);
    let d = dv.length();
    const u = d > 1e-6 ? dv.multiplyScalar(1 / d) : dv.set(0, -1, 0);
    d = clamp(d, Math.abs(l1 - l2) + 0.01, (l1 + l2) * 0.9995);
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pp = _v4.copy(pole).addScaledVector(u, -pole.dot(u));
    if (pp.lengthSq() < 1e-8) pp.set(0, 0, -1).addScaledVector(u, -u.z);
    pp.normalize();
    out.t.copy(s).addScaledVector(u, d);
    out.e.copy(s).addScaledVector(u, a).addScaledVector(pp, h);
    out.d1.subVectors(out.e, s).normalize();
    out.d2.subVectors(out.t, out.e).normalize();
    out.n.crossVectors(pp, u).normalize();
    return out;
  }

  _solveLegs(dt) {
    const F = this._F;
    const rest = this._rest;
    const g = this._gait;
    const w = g.w;
    const tr = this._turn;
    // Do not let the trailing airborne spring drag a toe through the floor on landing.
    const altitude = Math.max(0, this._y - 12) / this._k + Math.max(0, F.rootY);
    const canopyAir = this._propKind === 'umbrella';
    const air = Math.min(this._air.v, canopyAir ? smooth(altitude / 0.6) : clamp(altitude / 0.09, 0, 1));
    const A = this._A;
    const P = this._P;
    const tmp = this._footTmp || (this._footTmp = { z: 0, y: 0, psi: 0 });
    for (const side of ['L', 'R']) {
      const sg = side === 'L' ? 1 : -1;
      const limb = side === 'L' ? rest.legL : rest.legR;
      this._follow(limb.a);
      const hip = P[limb.a];
      // standing target (ground reference under the ankle)
      const stand = _v1.set(sg * F.stance, 0, (side === 'L' ? F.fLz : F.fRz) - 0.008);
      let psi = side === 'L' ? F.fLp : F.fRp;
      let lift = side === 'L' ? F.fLy : F.fRy;
      // turn-in-place steps
      if (tr.w > 0.02) {
        const ph = tr.phase;
        const mine = (Math.floor(ph) % 2 === 0) === (side === 'L');
        if (mine) lift += 0.05 * Math.sin(Math.PI * frac(ph)) * tr.w;
      }
      let gz = stand.z;
      let gy = lift;
      let gx = stand.x;
      if (w > 0.001) {
        gaitFoot(frac(g.phase + (side === 'L' ? 0 : 0.5)), g, tmp);
        gz = lerp(gz, tmp.z, w);
        gy = lerp(gy, tmp.y, w);
        gx = lerp(gx, sg * 0.085, w);
        psi = lerp(psi, tmp.psi, w);
      }
      const foot = { z: gz, y: gy, psi };
      const ankle = this._anklePos(foot, _v2.set(gx, 0, 0));
      // dangle while airborne: hang below the hips, toes pointing down
      if (air > 0.001) {
        const kick = Math.sin(this._clock * 3.1 + (side === 'L' ? 0 : 2.2)) * 0.05;
        const hang = _v3.set(hip.x + sg * 0.01, hip.y - 0.8, hip.z + 0.05 + kick);
        ankle.lerp(hang, air);
        psi = lerp(psi, canopyAir ? 18 : 32, air);
      }
      const pole = _v5.set(sg * 0.12, 0, 1).applyQuaternion(A[B.hips]);
      const res = this._ik2(hip, ankle, pole, limb);
      frameRot(A[limb.a], limb.r1, limb.n1, res.d1, res.n);
      frameRot(A[limb.b], limb.r2, limb.n2, res.d2, res.n);
      P[limb.b].copy(res.e);
      P[limb.c].copy(res.t);
      // foot orientation in model space (independent of the shin), toes slightly out
      const footN = side === 'L' ? B.footL : B.footR;
      const toeN = side === 'L' ? B.toeL : B.toeR;
      const yawOut = sg * 7 * (1 - w);
      eulerQ(A[footN], psi, yawOut + F.hipYaw * 0.3 * (1 - w), 0);
      const toeBend = psi > 0 ? -psi * 0.85 : 0;
      this._chain(toeN, eulerQ(_q1, toeBend, 0, 0));
      this._footG[side].set(gx, gy, gz);
      this._footPitch[side] = psi;
    }
  }

  _writeFingers(side) {
    const F = this._F;
    const hand = this._rest[`hand${side}`];
    const relax = this._relax || (this._relax = degShape(RELAXED));
    const open = this._open || (this._open = degShape(OPEN));
    const grip = side === 'R' && this._handShapes.R && !this._propMeta.empty ? this._handShapes.R : null;
    const gw = side === 'R' ? clamp(F.gripR, 0, 1) : 0;
    const fw = clamp(side === 'L' ? F.fistL : F.fistR, 0, 1);
    const ow = clamp(side === 'L' ? F.openL : F.openR, 0, 1);
    const ang = [0, 0, 0, 0];
    const dq = this._dqF || (this._dqF = [new T.Quaternion(), new T.Quaternion(), new T.Quaternion()]);
    for (const ch of hand.chains) {
      const r = relax[ch.finger];
      const g = grip ? grip[ch.finger] : r;
      const fi = hand.fist[ch.finger];
      const o = open[ch.finger];
      const n = ch.thumb ? 4 : 3;
      for (let i = 0; i < n; i++) {
        let v = lerp(r[i] ?? 0, g[i] ?? r[i] ?? 0, grip ? gw : 0);
        v = lerp(v, fi[i] ?? v, fw);
        v = lerp(v, o[i] ?? v, ow);
        ang[i] = v;
      }
      chainDeltas(ch, ang, dq);
      for (let k = 0; k < 3; k++) {
        const j = ch.joints[k];
        const bone = this._bones[j.name];
        if (!bone) continue;
        // local = Wparent0⁻¹ · D · W0 (hand space)
        bone.quaternion.copy(j.Wp0inv).multiply(dq[k]).multiply(j.W0);
      }
    }
  }

  _updateShadows() {
    const sh = this._shadow;
    if (!sh) return;
    const root = this._root;
    root.updateMatrixWorld(true);
    const hipsW = _v1.copy(this._P[B.hips]).applyMatrix4(root.matrixWorld);
    const lift = Math.max(0, this._F.rootY) + this._y / this._k;
    const fade = clamp(1 - lift / 1.2, 0, 1);
    sh.body.position.set(hipsW.x, 0.002, hipsW.z);
    const sc = 1 - 0.35 * (1 - fade);
    sh.body.scale.set(0.78 * sc, 0.5 * sc, 1);
    sh.body.material.opacity = 0.4 * fade;
    for (const side of ['L', 'R']) {
      const fn = side === 'L' ? B.footL : B.footR;
      const pw = _v2.copy(this._P[fn]).applyMatrix4(root.matrixWorld);
      const toe = _v3.copy(this._P[side === 'L' ? B.toeL : B.toeR]).applyMatrix4(root.matrixWorld);
      const m = sh[side];
      const h = Math.max(0, pw.y - this._rest.ankleY);
      const f = clamp(1 - h / 0.16, 0, 1) * fade;
      m.position.set((pw.x + toe.x) / 2, 0.003, (pw.z + toe.z) / 2);
      m.rotation.z = -Math.atan2(toe.x - pw.x, toe.z - pw.z) + Math.PI / 2;
      m.scale.set(0.3, 0.15, 1).multiplyScalar(1 - 0.3 * (1 - f));
      m.material.opacity = 0.55 * f;
    }
  }

  // ---------------------------------------------------------------------------------------------- projection
  _project(modelPt, out = {}) {
    if (!this._root) return null;
    const v = _v5.copy(modelPt).applyMatrix4(this._root.matrixWorld).project(this._camera);
    out.x = ((v.x + 1) / 2) * this._cw - this._padSide;
    out.y = ((1 - v.y) / 2) * this._ch - this._padTop; // el-local (el top = head-room start)
    return out;
  }

  _fallbackAnchor(name) {
    // before the model is ready: rest-pose estimates in el-local px
    const k = this._k;
    const cx = this._width / 2;
    const ground = this._height;
    const pts = { top: [0, 1.863], mouth: [0, 1.62], chin: [0, 1.58], eyeL: [0.03, 1.71], eyeR: [-0.03, 1.71], earL: [0.09, 1.69], earR: [-0.09, 1.69], chest: [0, 1.36], handL: [0.28, 1.0], handR: [-0.28, 1.0], ground: [0, 0] };
    const p = pts[name] || pts.chest;
    return { x: cx + p[0] * k, y: ground - p[1] * k };
  }

  _anchorLocal(name) {
    if (!this._ready) return this._fallbackAnchor(name);
    this._root.updateMatrixWorld(true);
    let key = name;
    if (name === 'eyeR' || name === 'eyeL' || name === 'earR' || name === 'earL') {
      // public R/L = screen-right/left, whichever avatar side is there now
      const kind = name.startsWith('eye') ? 'eye' : 'ear';
      const a = this._project(this._anchorsM[`${kind}_l`], {});
      const b = this._project(this._anchorsM[`${kind}_r`], {});
      const right = a.x >= b.x ? a : b;
      const left = a.x >= b.x ? b : a;
      return name.endsWith('R') ? right : left;
    }
    if (name === 'handR' || name === 'handL' || name === 'ground' || this._anchorsM[key]) {
      if (name === 'handR' && this._prop && !this._propMeta.empty) {
        return this._project(this._spoutM.clone().lerp(this._anchorsM.handR, 0.5), {});
      }
      return this._project(this._anchorsM[key], {});
    }
    return this._project(this._anchorsM.chest, {});
  }

  _elTop() {
    return this._hostH - this._height - this._y;
  }

  anchor(name) {
    const p = this._anchorLocal(name);
    return { x: this._x + p.x, y: this._elTop() + p.y };
  }

  _hitBoxes() {
    if (this._hitFrame === this._frameN && this._hitCache) return this._hitCache;
    const pts = [];
    const add = (v) => pts.push(this._project(v, {}));
    const P = this._P;
    for (const n of [B.shL, B.shR, B.armL, B.armR, B.foreL, B.foreR, B.handL, B.handR, B.hips, B.upL, B.upR, B.legL, B.legR, B.footL, B.footR, B.toeL, B.toeR]) add(P[n]);
    add(this._anchorsM.handL);
    add(this._anchorsM.handR);
    const head = [this._project(this._anchorsM.top, {}), this._project(this._anchorsM.chin, {}), this._project(this._anchorsM.ear_l, {}), this._project(this._anchorsM.ear_r, {})];
    const pad = 0.05 * this._k;
    const box = (arr, p) => {
      const xs = arr.map((q) => q.x);
      const ys = arr.map((q) => q.y);
      return { x0: Math.min(...xs) - p, x1: Math.max(...xs) + p, y0: Math.min(...ys) - p, y1: Math.max(...ys) + p };
    };
    this._hitCache = { body: box(pts, pad), head: box(head, pad * 0.6) };
    this._hitFrame = this._frameN;
    return this._hitCache;
  }

  hitTest(cx, cy) {
    if (!this._ready) return false;
    const r = this._canvas.getBoundingClientRect();
    if (!r.width) return false;
    this._root.updateMatrixWorld(true);
    const lx = ((cx - r.left) / r.width) * this._cw - this._padSide;
    const ly = ((cy - r.top) / r.height) * this._ch - this._padTop;
    const { body, head } = this._hitBoxes();
    const inBox = (b) => lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1;
    if (inBox(head)) {
      const hx = (head.x0 + head.x1) / 2;
      const hy = (head.y0 + head.y1) / 2;
      const nx = (lx - hx) / ((head.x1 - head.x0) / 2);
      const ny = (ly - hy) / ((head.y1 - head.y0) / 2);
      if (nx * nx + ny * ny <= 1.1) return true;
    }
    if (!inBox(body)) return false;
    // shave the empty corners beside the legs / above the shoulders
    const shY = Math.min(this._project(this._P[B.shL], {}).y, this._project(this._P[B.shR], {}).y);
    return ly >= shY - 0.04 * this._k || inBox(head);
  }

  // ---------------------------------------------------------------------------------------------- actions ctx
  _makeCtx(token, opts) {
    const self = this;
    const guard = () => {
      if (token.cancelled) throw CANCEL;
    };
    const ctx = {
      opts,
      get cancelled() { return token.cancelled; },
      get mood() { return self._mood; },
      get facing() { return self._facing; },
      get propId() { return self._propId; },
      get propKind() { return self._propKind; },
      get prop() { return self._propMeta || PROP3D.none; },
      av: self._api,
      rand,
      t: () => self._clock,
      wait(ms) {
        guard();
        const pending = new Promise((res, rej) => {
          self._after(ms, () => (token.cancelled ? rej(CANCEL) : res()));
        });
        pending.catch(() => {});
        return pending;
      },
      to(values, ms = 300, ease = 'inOut') {
        guard();
        const e = easeFn(ease);
        for (const [k, v] of Object.entries(values)) {
          const s = self._S[k];
          if (!s) continue;
          s.act = { from: s.v, to: v, t0: self._clock, dur: Math.max(0, ms / 1000), ease: e, release: false };
          token.touched.add(k);
        }
        return ctx.wait(ms);
      },
      set(values) {
        return ctx.to(values, 0);
      },
      release(names, ms = 380) {
        for (const k of names) {
          const s = self._S[k];
          if (s && s.act) s.act = { from: s.v, to: 0, t0: self._clock, dur: ms / 1000, ease: EASE3D.inOut, release: true };
        }
      },
      ik(side, spec, ms = 450, ease = 'inOut') {
        guard();
        const keys = side === 'L' ? ['hLx', 'hLy', 'hLz'] : ['hRx', 'hRy', 'hRz'];
        const from = keys.map((k) => self._S[k].v);
        let arc = 0;
        if (spec) {
          const to = self._evalSpec(side, spec);
          const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
          arc = spec.arc ?? Math.min(0.1, dist * 0.3);
        }
        self._ik[side] = { from, spec: spec ? { ...spec } : null, t0: self._clock, dur: ms / 1000, ease: easeFn(ease), arc };
        token.touchedIk.add(side);
        return ctx.wait(ms);
      },
      hop({ height = 0.16, ms = 560, crouch = 0.07, arms = null } = {}) {
        guard();
        return (async () => {
          const prep = ms * 0.28;
          const air = Math.min(ms * 0.5, 1000 * Math.sqrt(8 * Math.max(0.001, height) / 9.81));
          const landMs = ms - prep - air;
          // Anticipation: arms swing down and back with the crouch (never out to a T before the jump).
          await ctx.to({ hipY: -crouch, spinePitch: 6, chestPitch: 3, ...(arms === 'up'
            ? { hLx: 0.16, hLy: -0.5, hLz: -0.1, hRx: -0.16, hRy: -0.5, hRz: -0.08 }
            : { hLz: -0.04, hRz: -0.02 }) }, prep, 'inOut');
          self._emit('hop', {});
          const up = { hipY: 0.01, spinePitch: -1, chestPitch: -4 };
          if (arms === 'up') Object.assign(up, { hLx: 0.17, hLy: 0.5, hLz: 0.06, hRx: -0.17, hRy: 0.5, hRz: 0.06, pLx: 1, pLy: -0.2, pLz: -0.3, pRx: -1, pRy: -0.2, pRz: -0.3, fistL: 1, headPitch: -7 });
          if (arms === 'out') Object.assign(up, { hLx: 0.3, hLy: -0.25, hRx: -0.3, hRy: -0.25, openL: 1 });
          ctx.to(up, air * 0.85, 'inOut');
          // ballistic arc on the root
          const t0 = self._clock;
          const dur = air / 1000;
          const rs = self._S.rootY;
          s_flight(rs, t0, dur, height, self);
          await ctx.wait(air);
          self._emit('land', {});
          self._emit('step', { foot: 'both' });
          await ctx.to({ hipY: -crouch * 0.9, spinePitch: 5 }, landMs * 0.35, 'out');
          await ctx.to({ hipY: 0 }, landMs * 0.65, 'inOut');
        })();
      },
      drain(amount = 0.08) {
        self._liquid.target = clamp(self._liquid.target - amount, 0.12, 1);
      },
      reserveThrowFrame: () => self._reserveThrowFrame(),
      tossUmbrella: dir => self._tossUmbrella(dir),
      emit: (name, data) => self._emit(name, data),
      fx: (name, o) => self._api.fx(name, o),
      say: (ms) => self._api.say(ms),
      expression: (name) => self._setExpression(name),
      idle({ breath, sway } = {}) {
        if (breath !== undefined) ctx.to({ breath }, 200);
        if (sway !== undefined) ctx.to({ sway }, 200);
      },
      ownHead(on = true) {
        if (self._action) self._action.ownsHead = on;
      },
    };
    return ctx;
  }

  _releaseAction(ms, token) {
    for (const name of CH_NAMES) {
      const s = this._S[name];
      if (s.act && !s.act.release) s.act = { from: s.v, to: 0, t0: this._clock, dur: ms / 1000, ease: EASE3D.inOut, release: true };
    }
    for (const side of ['L', 'R']) {
      if (this._ik[side] && this._ik[side].spec) {
        const keys = side === 'L' ? ['hLx', 'hLy', 'hLz'] : ['hRx', 'hRy', 'hRz'];
        this._ik[side] = { from: keys.map((k) => this._S[k].v), spec: null, t0: this._clock, dur: (ms * 1.3) / 1000, ease: EASE3D.inOut, arc: 0.03 };
      }
    }
    this._S.rootY.act = { from: this._S.rootY.v, to: 0, t0: this._clock, dur: 0.2, ease: EASE3D.out, release: true };
  }

  _cancelAction() {
    const a = this._action;
    if (!a) return;
    a.token.cancelled = true;
    this._action = null;
    this._releaseAction(300, a.token);
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
      anchorWorld: (n) => self.anchor(n),
      anchorLocal: (n) => self._anchorLocal(n),
      track(anim) {
        anim.playbackRate = self._ts || 1e-6;
        self._anims.add(anim);
        const drop = () => self._anims.delete(anim);
        anim.finished.then(drop, drop);
        return anim;
      },
      after: (ms, fn) => self._after(ms, fn),
      setBlush: () => {},
      emit: (n, d) => self._emit(n, d),
    };
  }

  _syncAnimRates() {
    for (const a of this._anims) a.playbackRate = this._ts || 1e-6;
  }
}

// ballistic flight on the rootY channel (overrides the spring through an action tween)
function s_flight(s, t0, dur, height, self) {
  s.act = {
    from: 0,
    to: () => 0,
    t0,
    dur,
    ease: (t) => t,
    release: false,
  };
  // replace the linear tween with a parabola: value = 4h·t(1−t)
  s.act.to = () => 0;
  s.act.ease = () => 0;
  const tween = s.act;
  tween.from = 0;
  const orig = self._baseOf.bind(self);
  s.act = {
    from: 0, t0, dur, release: false,
    get to() { return 0; },
    ease: () => 0,
  };
  // custom evaluation: hijack via dyn each frame until done
  const start = t0;
  const step = () => {
    const t = clamp((self._clock - start) / dur, 0, 1);
    s.dyn = 4 * height * t * (1 - t);
    if (t < 1 && !self._destroyed) self._after(0, step);
    else {
      s.dyn = 0;
      s.act = null;
    }
  };
  void orig;
  step();
}

// gait foot: ground reference z (relative to hips, forward +), lift y and pitch psi (deg, + heel up)
function gaitFoot(phi, g, out) {
  const b = g.beta;
  const C = g.C;
  if (phi < b) {
    const u = phi / b;
    out.z = C * b * (0.46 - u);
    out.y = 0;
    if (u < 0.14) out.psi = -g.heel * (1 - smooth(u / 0.14));
    else if (u > 0.62) out.psi = g.toe * smooth((u - 0.62) / 0.38);
    else out.psi = 0;
    return out;
  }
  const u = (phi - b) / (1 - b);
  out.z = C * b * (-0.54 + smooth(u)) - C * (1 - b) * (2 * u ** 3 - 3 * u ** 2 + u);
  out.y = g.lift * Math.sin(Math.PI * smooth(u));
  out.psi = u < 0.45 ? lerp(g.toe, -5, smooth(u / 0.45)) : lerp(-5, -g.heel, smooth((u - 0.45) / 0.55));
  return out;
}

// ------------------------------------------------------------------------------------------------- actions
const ACTIONS3D = {
  async drink(c) {
    const meta = c.prop;
    const tilt = meta.drinkTilt || 100;
    const liquid = !!meta.water;
    c.ownHead();
    c.idle({ sway: 0.3 });
    await c.to({ hipY: -0.012, headPitch: 3, shRUp: -8 }, 170, 'out');
    c.to({ hipY: 0, aTilt: tilt * 0.22, pRx: -1, pRy: -0.25, pRz: -0.2, shRUp: 2, shRFwd: 6 }, 420, 'inOut');
    c.ik('R', { anchor: 'mouth', spout: true, off: [0, -0.004, 0.014] }, 680, 'inOut');
    await c.wait(330);
    c.to({ aTilt: tilt, neckPitch: -7, headPitch: -12, chestPitch: -4, headRoll: 3 }, 480, 'inOut');
    await c.wait(470);
    const gulps = liquid ? 3 : 2;
    for (let i = 0; i < gulps; i++) {
      await c.to({ headPitch: -14, neckPitch: -8 }, 170, 'out');
      c.emit('gulp', { i });
      if (liquid) c.drain(0.06);
      await c.to({ headPitch: -11, neckPitch: -6.5 }, 260, 'inOut');
    }
    c.to({ aTilt: 0, neckPitch: 0, headPitch: 2, chestPitch: -2, headRoll: 0 }, 420, 'inOut');
    await c.wait(150);
    c.ik('R', null, 650, 'inOut');
    c.release(['pRx', 'pRy', 'pRz', 'shRUp', 'shRFwd', 'aTilt'], 600);
    // satisfied exhale
    await c.to({ chestPitch: -5, shLUp: -3, shRUp: -3, headPitch: -3 }, 380, 'out');
    await c.to({ chestPitch: 0, shLUp: -7, shRUp: -7, headPitch: 1 }, 520, 'inOut');
  },

  async call(c) {
    c.ownHead();
    c.to({ pRx: -1, pRy: -0.55, pRz: -0.25, shRUp: 0, aTilt: 40, aRoll: 0, palmW: 1, palmX: 1, palmY: 0, palmZ: 0.15 }, 520, 'inOut');
    await c.ik('R', { anchor: 'ear_r', spout: true, off: [-0.02, -0.005, 0.018] }, 700, 'inOut');
    await c.to({ headRoll: 8, headYaw: -6, neckRoll: 3 }, 300, 'inOut');
    for (let i = 0; i < 3; i++) {
      c.say(700);
      await c.to({ headPitch: 6 }, 200, 'inOut');
      await c.to({ headPitch: -1 }, 260, 'inOut');
      await c.wait(260);
    }
    await c.to({ headPitch: 2, headRoll: 3 }, 260, 'inOut');
    c.ik('R', null, 650, 'inOut');
    c.release(['pRx', 'pRy', 'pRz', 'shRUp', 'aTilt', 'aRoll', 'palmW', 'palmX', 'palmY', 'palmZ', 'headRoll', 'headYaw', 'neckRoll'], 600);
    await c.wait(600);
  },

  async stretch(c) {
    c.ownHead();
    c.idle({ sway: 0, breath: 0.4 });
    const up = { hLx: 0.05, hLy: 0.5, hLz: 0.03, hRx: -0.05, hRy: 0.5, hRz: 0.03, pLx: 1, pLy: 0.1, pLz: -0.25, pRx: -1, pRy: 0.1, pRz: -0.25, openL: 1, chestPitch: -9, headPitch: -9, spinePitch: -2, shLUp: 10, shRUp: 10, aRoll: 0, solveR: 0.7 };
    await c.to(up, 900, 'inOut');
    await c.to({ spineRoll: -11, chestRoll: -3, hipX: -0.025, headRoll: -4 }, 650, 'inOut');
    await c.wait(220);
    await c.to({ spineRoll: 11, chestRoll: 3, hipX: 0.025, headRoll: 4 }, 900, 'inOut');
    await c.wait(220);
    await c.to({ spineRoll: 0, chestRoll: 0, hipX: 0, headRoll: 0 }, 520, 'inOut');
    // Lower the hands on an outward arc, avoiding a straight path through the shoulder.
    await c.to({ hLx: 0.42, hLy: 0.04, hLz: 0.08, hRx: -0.42, hRy: 0.04, hRz: 0.08, shLUp: 0, shRUp: 0 }, 500, 'inOut');
    await c.to({ hLx: 0.16, hLy: -0.4, hLz: 0.1, hRx: -0.16, hRy: -0.4, hRz: 0.1, chestPitch: -2, headPitch: 0, shLUp: -7, shRUp: -7, openL: 0.4, solveR: 1 }, 650, 'inOut');
    c.idle({ sway: 1, breath: 1 });
  },

  async breathe(c) {
    c.ownHead();
    c.idle({ breath: 0, sway: 0.2 });
    for (let i = 0; i < 3; i++) {
      await c.to({ chestPitch: -8, spinePitch: -1.5, shLUp: 4, shRUp: 4, headPitch: -4, hLx: 0.12, hRx: -0.12, hLz: 0.1, hRz: 0.1, openL: 0.6 }, 1500, 'inOutSine');
      c.fx('puff', { anchor: 'mouth', dir: 1 });
      await c.to({ chestPitch: 1.5, spinePitch: 2.5, shLUp: -9, shRUp: -9, headPitch: 3, hLx: 0.07, hRx: -0.07, hLz: 0.05, hRz: 0.05, openL: 0.2 }, 1700, 'inOutSine');
    }
    c.idle({ breath: 1, sway: 1 });
  },

  async cheer(c) {
    c.ownHead();
    await c.hop({ height: 0.13, ms: 1000, crouch: 0.065, arms: 'up' });
    // a little fist pump on the way down
    await c.to({ hLy: 0.3, hRy: 0.3, hLx: 0.22, hRx: -0.22 }, 260, 'inOut');
    await c.to({ hLy: 0.46, hRy: 0.46, hLx: 0.17, hRx: -0.17 }, 260, 'inOut');
    // Lower along an outward arc below shoulder height in one continuous sweep (no pause at a T).
    await c.to({ hLx: 0.3, hLy: -0.14, hLz: 0.14, hRx: -0.3, hRy: -0.14, hRz: 0.14 }, 340, 'in');
    await c.to({ hLx: 0.12, hLy: -0.42, hLz: 0.08, hRx: -0.12, hRy: -0.42, hRz: 0.1, fistL: 0, headPitch: -2, chestPitch: -3 }, 560, 'out');
  },

  async nod(c) {
    c.ownHead();
    await c.to({ chestPitch: -3 }, 200);
    for (let i = 0; i < 2; i++) {
      await c.to({ headPitch: 11, neckPitch: 4 }, 210, 'inOut');
      await c.to({ headPitch: -3, neckPitch: -1 }, 250, 'inOut');
    }
    await c.to({ headPitch: 0, neckPitch: 0 }, 220, 'inOut');
  },

  async wave(c) {
    await c.to({ hLx: 0.25, hLy: 0.3, hLz: 0.1, pLx: 0.85, pLy: -1, pLz: -0.15, openL: 1, wLt: -55, wLf: -12, shLUp: 2, headRoll: -4 }, 360, 'out');
    for (let i = 0; i < 3; i++) {
      await c.to({ hLx: 0.31, wLd: -16 }, 190, 'inOut');
      await c.to({ hLx: 0.2, wLd: 16 }, 190, 'inOut');
    }
    await c.to({ wLd: 0, hLx: 0.25 }, 160, 'inOut');
  },

  async jump(c) {
    c.ownHead();
    c.expression('surprised');
    await c.hop({ height: 0.14, ms: 600, crouch: 0.055, arms: 'out' });
    c.expression('neutral');
  },

  async land(c) {
    c.emit('land', {});
    if (c.opts.umbrella) {
      await c.to({ hipY: -0.055, spinePitch: 5, chestPitch: 1, headPitch: 3, hLx: 0.18, hLy: -0.37 }, 160, 'inOut');
      await c.to({ hipY: 0, spinePitch: 1.5, chestPitch: -1.5, headPitch: 0, hLx: 0.1, hLy: -0.44 }, 320, 'inOut');
      return;
    }
    await c.to({ hipY: -0.11, spinePitch: 9, chestPitch: 4, headPitch: 4, hLx: 0.2, hRx: -0.2, hLz: 0.14, hRz: 0.14, hLy: -0.38, hRy: -0.38 }, 110, 'out');
    await c.to({ hipY: 0, spinePitch: 1.5, chestPitch: -2, headPitch: -1, hLx: 0.09, hRx: -0.09, hLz: 0.07, hRz: 0.07, hLy: -0.46, hRy: -0.46 }, 480, 'outBack');
  },

  async throwUmbrella(c) {
    if (c.propKind !== 'umbrella') return;
    c.reserveThrowFrame();
    c.ownHead();
    const dir = c.opts.dir || 1;
    await c.to({ hRx: -0.1 - dir * 0.16, hRy: 0.25, hRz: 0.14, chestYaw: -dir * 5 }, 180, 'inOut');
    await c.to({ hRx: -0.1 + dir * 0.22, hRy: 0.18, hRz: 0.2, aRoll: -dir * 14, chestYaw: dir * 5 }, 240, 'in');
    const flight = c.tossUmbrella(dir);
    c.emit('release', { dir });
    // Complete the follow-through and reach the hip before revealing the reminder's prop.
    await c.to({ hRx: -0.12, hRy: -0.47, hRz: -0.07, pRx: -0.38, pRy: -0.05, pRz: -1,
      aRoll: 0, aTilt: 0, chestYaw: 0, openR: 1, propVis: 0 }, 360, 'inOut');
    await c.to({ openR: 0 }, 140, 'inOut');
    c.av.pose('present', { duration: 600 });
    await c.to({ hRx: -0.07, hRy: -0.235, hRz: 0.27, pRx: -0.55, pRy: -1, pRz: -0.4,
      aTilt: -7, aRoll: 5, propVis: 1 }, 550, 'inOut');
    await flight;
  },

  async sigh(c) {
    c.ownHead();
    c.idle({ breath: 0 });
    await c.to({ shLUp: 4, shRUp: 4, chestPitch: -4, headPitch: -3 }, 650, 'inOutSine');
    c.fx('puff', { anchor: 'mouth', dir: 1, duration: 1300 });
    await c.to({ shLUp: -13, shRUp: -13, chestPitch: 8, spinePitch: 6, headPitch: 9, neckPitch: 6 }, 1000, 'inOutSine');
    await c.wait(250);
    c.idle({ breath: 1 });
  },

  async giggle(c) {
    c.ownHead();
    c.ik('L', { anchor: 'mouth', off: [0.03, -0.035, 0.06] }, 500, 'inOut');
    c.to({ openL: 0.4, headRoll: 6, headPitch: 4, pLx: 0.6, pLy: -1, pLz: -0.2 }, 260, 'out');
    for (let i = 0; i < 3; i++) {
      await c.to({ shLUp: 1, shRUp: 1, chestPitch: -2 }, 140, 'inOut');
      await c.to({ shLUp: -4, shRUp: -4, chestPitch: 1 }, 160, 'inOut');
    }
    c.ik('L', null, 380, 'inOut');
    await c.to({ headRoll: 0, headPitch: 0, openL: 0 }, 300, 'inOut');
  },

  async lookAround(c) {
    c.ownHead();
    await c.to({ neckYaw: -18, headYaw: -24, chestYaw: -4, headPitch: -1 }, 520, 'inOut');
    await c.wait(380);
    await c.to({ neckYaw: 18, headYaw: 24, chestYaw: 4, headPitch: 1 }, 820, 'inOut');
    await c.wait(380);
    await c.to({ neckYaw: 0, headYaw: 0, chestYaw: 0, headPitch: 0 }, 480, 'inOut');
  },

  async yawn(c) {
    c.ownHead();
    c.idle({ breath: 0 });
    c.to({ chestPitch: -6, shLUp: 5, shRUp: 5 }, 700, 'inOut');
    c.to({ pLx: 0.5, pLy: -1, pLz: -0.3, openL: 0.5 }, 400);
    c.ik('L', { anchor: 'mouth', off: [0.012, -0.012, 0.045] }, 650, 'inOut');
    await c.to({ neckPitch: -10, headPitch: -12 }, 750, 'inOut');
    await c.wait(700);
    c.ik('L', null, 600, 'inOut');
    await c.to({ chestPitch: 2, shLUp: -8, shRUp: -8, neckPitch: 2, headPitch: 3 }, 800, 'inOutSine');
    c.idle({ breath: 1 });
  },

  async pet(c) {
    c.ownHead();
    c.expression('love');
    await c.to({ shLUp: 5, shRUp: 5, headRoll: 9, headPitch: 3, chestPitch: -2 }, 220, 'out');
    await c.to({ headRoll: -7 }, 300, 'inOut');
    await c.to({ headRoll: 6 }, 300, 'inOut');
    await c.to({ shLUp: -6, shRUp: -6, headRoll: 0, headPitch: 0, chestPitch: 0 }, 320, 'inOut');
    c.expression('neutral');
  },

  async poke(c) {
    c.ownHead();
    c.expression('surprised');
    await c.hop({ height: 0.07, ms: 420, crouch: 0.03, arms: 'out' });
    await c.to({ headRoll: 6, shLUp: 3, shRUp: 3 }, 160, 'out');
    for (let i = 0; i < 3; i++) {
      await c.to({ shLUp: 4, shRUp: 4 }, 70);
      await c.to({ shLUp: -3, shRUp: -3 }, 80);
    }
    await c.to({ headRoll: 0 }, 220);
    c.expression('neutral');
  },

  async dance(c) {
    c.ownHead();
    for (let i = 0; i < 4; i++) {
      const s = i % 2 ? 1 : -1;
      c.to({ hipX: 0.03 * s, hipRoll: 4 * s, spineRoll: -5 * s, headRoll: 4 * s, hLy: -0.2, hRy: -0.2, hLz: 0.22, hRz: 0.22, hLx: 0.1, hRx: -0.1, fistL: 1 }, 240, 'inOut');
      await c.to({ hipY: -0.04 }, 150, 'out');
      await c.to({ hipY: 0 }, 150, 'inOut');
    }
    await c.to({ hipX: 0, hipRoll: 0, spineRoll: 0, headRoll: 0, fistL: 0 }, 300);
  },
};
export const ACTIONS_3D = Object.keys(ACTIONS3D);

// ------------------------------------------------------------------------------------------------- props (3D)
function fakeGlass(opts = {}) {
  const m = new T.MeshPhysicalMaterial({
    color: opts.color ?? 0xeaf6ff,
    roughness: opts.roughness ?? 0.1,
    metalness: 0,
    transparent: true,
    opacity: opts.opacity ?? 0.16,
    depthWrite: false,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 2.2,
    side: opts.side ?? T.FrontSide,
  });
  const rim = opts.rim ?? 0.85;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float nbF = pow( 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) ), 2.4 );
       diffuseColor.a = mix( diffuseColor.a, ${rim.toFixed(2)}, nbF );
       outgoingLight += vec3( 0.62, 0.8, 1.0 ) * nbF * 0.32;
       #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `nbglass${rim}`;
  return m;
}

function buildProp(kind, emoji) {
  if (kind === 'none') return null;
  const group = new T.Group();
  const out = { group, water: null, steam: null };
  if (kind === 'bottle') {
    // ~0.235 m sports bottle, gripped at 40 % of its height
    const H = 0.235;
    const y0 = -0.4 * H;
    const prof = [[0, 0], [0.026, 0], [0.032, 0.004], [0.034, 0.014], [0.034, 0.06], [0.0315, 0.085], [0.0315, 0.1], [0.034, 0.122], [0.034, 0.158], [0.031, 0.176], [0.024, 0.19], [0.0185, 0.198], [0.0175, 0.206]];
    const pts = prof.map(([r, y]) => new T.Vector2(r, y + y0));
    const geo = new T.LatheGeometry(pts, 40);
    const back = new T.Mesh(geo, fakeGlass({ side: T.BackSide, opacity: 0.12, rim: 0.5 }));
    back.renderOrder = 3;
    const front = new T.Mesh(geo, fakeGlass({ opacity: 0.16, rim: 0.82 }));
    front.renderOrder = 5;
    // water
    const wpts = prof.slice(0, 11).map(([r, y]) => new T.Vector2(Math.max(0, r - 0.0028), Math.max(0.003, y) + y0));
    wpts[0].set(0, y0 + 0.003);
    const plane = new T.Plane(new T.Vector3(0, -1, 0), 0);
    const wmat = new T.MeshPhysicalMaterial({ color: 0x1ea7ff, emissive: 0x0b4f8a, emissiveIntensity: 0.55, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.72, depthWrite: false, side: T.DoubleSide, clippingPlanes: [plane], clearcoat: 0.6, envMapIntensity: 1.4 });
    const water = new T.Mesh(new T.LatheGeometry(wpts, 32), wmat);
    water.renderOrder = 4;
    // cap + cyan accent ring
    const capMat = new T.MeshPhysicalMaterial({ color: 0x1a2030, roughness: 0.38, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.3 });
    const capPts = [[0, 0.236], [0.012, 0.236], [0.0185, 0.233], [0.0195, 0.228], [0.0195, 0.206], [0.0185, 0.202], [0, 0.202]].map(([r, y]) => new T.Vector2(r, y + y0));
    const cap = new T.Mesh(new T.LatheGeometry(capPts.reverse(), 32), capMat);
    const ring = new T.Mesh(new T.TorusGeometry(0.0196, 0.0016, 8, 40), new T.MeshStandardMaterial({ color: 0x38d3ee, emissive: 0x38d3ee, emissiveIntensity: 0.9, roughness: 0.3 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.208 + y0;
    // frosted label band
    const label = new T.Mesh(new T.CylinderGeometry(0.0344, 0.0344, 0.034, 40, 1, true), new T.MeshPhysicalMaterial({ color: 0xf2f7ff, roughness: 0.55, transparent: true, opacity: 0.55, depthWrite: false, side: T.DoubleSide }));
    label.position.y = 0.035 + y0;
    label.renderOrder = 5;
    group.add(back, water, label, front, cap, ring);
    out.water = { mesh: water, plane, y0: y0 + 0.004, y1: y0 + 0.19 };
  } else if (kind === 'glass') {
    const H = 0.115;
    const y0 = -0.35 * H;
    const prof = [[0, 0], [0.03, 0], [0.032, 0.003], [0.037, H]];
    const pts = prof.map(([r, y]) => new T.Vector2(r, y + y0));
    const geo = new T.LatheGeometry(pts, 40);
    const back = new T.Mesh(geo, fakeGlass({ side: T.BackSide, opacity: 0.1, rim: 0.45 }));
    back.renderOrder = 3;
    const front = new T.Mesh(geo, fakeGlass({ opacity: 0.14, rim: 0.8 }));
    front.renderOrder = 5;
    const plane = new T.Plane(new T.Vector3(0, -1, 0), 0);
    const wpts = [[0, 0.008], [0.028, 0.008], [0.0345, H - 0.004]].map(([r, y]) => new T.Vector2(r, y + y0));
    const water = new T.Mesh(new T.LatheGeometry(wpts, 32), new T.MeshPhysicalMaterial({ color: 0x29b0ff, emissive: 0x0b4f8a, emissiveIntensity: 0.5, roughness: 0.12, transparent: true, opacity: 0.65, depthWrite: false, side: T.DoubleSide, clippingPlanes: [plane] }));
    water.renderOrder = 4;
    group.add(back, water, front);
    out.water = { mesh: water, plane, y0: y0 + 0.008, y1: y0 + H - 0.004 };
  } else if (kind === 'mug') {
    // held by the handle: the body sits beyond the fingers
    const body = new T.Group();
    const H = 0.095;
    const prof = [[0, 0], [0.036, 0], [0.04, 0.006], [0.042, H], [0.038, H], [0.036, 0.012], [0, 0.012]];
    const mat = new T.MeshPhysicalMaterial({ color: 0x272b36, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.15 });
    const cup = new T.Mesh(new T.LatheGeometry(prof.map(([r, y]) => new T.Vector2(r, y)), 36), mat);
    const coffee = new T.Mesh(new T.CircleGeometry(0.037, 32), new T.MeshStandardMaterial({ color: 0x3b2316, roughness: 0.25 }));
    coffee.rotation.x = -Math.PI / 2;
    coffee.position.y = H - 0.014;
    const stripe = new T.Mesh(new T.CylinderGeometry(0.0423, 0.0423, 0.006, 36, 1, true), new T.MeshStandardMaterial({ color: 0x38d3ee, emissive: 0x38d3ee, emissiveIntensity: 0.5 }));
    stripe.position.y = H - 0.012;
    body.add(cup, coffee, stripe);
    body.position.set(0, -0.045, 0.05);
    const handle = new T.Mesh(new T.TorusGeometry(0.024, 0.0065, 10, 24, Math.PI * 1.2), mat);
    handle.rotation.set(0, Math.PI / 2, -Math.PI * 0.6);
    handle.position.set(0, 0.0, 0.012);
    group.add(body, handle);
    out.steam = [];
    const steamTex = blobTexture(true);
    for (let i = 0; i < 3; i++) {
      const sp = new T.Sprite(new T.SpriteMaterial({ map: steamTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      body.add(sp);
      out.steam.push({ sprite: sp, t: i / 3, dur: 1.6 + i * 0.3, ph: i * 1.7 });
    }
  } else if (kind === 'phone') {
    const w = 0.072;
    const h = 0.152;
    const r = 0.009;
    const shape = new T.Shape();
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    shape.lineTo(w / 2, h / 2 - r);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const geo = new T.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 6 });
    const bodyMat = new T.MeshPhysicalMaterial({ color: 0x1b1f28, roughness: 0.3, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.1 });
    const phone = new T.Mesh(geo, bodyMat);
    const screen = new T.Mesh(new T.PlaneGeometry(w - 0.006, h - 0.008), new T.MeshBasicMaterial({ map: phoneScreenTexture(), toneMapped: false }));
    screen.position.z = 0.0075;
    const ph = new T.Group();
    ph.add(phone, screen);
    // phone frame: long axis = prop axis (+Y), screen faces +Z (away from the palm); held near its lower third
    ph.position.set(0, 0.025, 0.0);
    group.add(ph);
  } else if (kind === 'umbrella') {
    const shaftMat = new T.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.4, metalness: 0.6 });
    const shaft = new T.Mesh(new T.CylinderGeometry(0.0055, 0.0055, 0.56, 10), shaftMat);
    shaft.position.y = 0.26;
    const handle = new T.Mesh(new T.TorusGeometry(0.028, 0.0085, 10, 20, Math.PI), new T.MeshStandardMaterial({ color: 0x151821, roughness: 0.5 }));
    handle.rotation.z = Math.PI;
    handle.position.set(0.028, -0.035, 0);
    const grip = new T.Mesh(new T.CylinderGeometry(0.011, 0.011, 0.07, 14), new T.MeshStandardMaterial({ color: 0x151821, roughness: 0.6 }));
    grip.position.y = 0.0;
    const can = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      can.push(new T.Vector2(Math.sin(t * Math.PI * 0.5) * 0.5, Math.cos(t * Math.PI * 0.5) * 0.2));
    }
    can.push(new T.Vector2(0.505, -0.008));
    const canopy = new T.Mesh(new T.LatheGeometry(can, 8), new T.MeshPhysicalMaterial({ color: 0x1c2333, roughness: 0.55, sheen: 0.6, sheenColor: 0x38d3ee, side: T.DoubleSide, flatShading: true }));
    canopy.position.y = 0.54;
    const trim = new T.Mesh(new T.TorusGeometry(0.502, 0.004, 6, 8), new T.MeshStandardMaterial({ color: 0x38d3ee, emissive: 0x38d3ee, emissiveIntensity: 0.8 }));
    trim.rotation.x = Math.PI / 2;
    trim.rotation.z = Math.PI / 8;
    trim.position.y = 0.534;
    const tip = new T.Mesh(new T.CylinderGeometry(0.004, 0.008, 0.05, 8), shaftMat);
    tip.position.y = 0.76;
    const fabric = new T.Group();
    fabric.add(canopy, trim);
    out.canopy = fabric;
    group.add(shaft, handle, grip, fabric, tip);
  } else if (kind === 'sprite') {
    const sp = new T.Sprite(new T.SpriteMaterial({ map: emojiTexture(emoji), transparent: true, depthWrite: false }));
    sp.scale.set(0.13, 0.13, 0.13);
    sp.position.set(0, 0.02, 0.05);
    sp.renderOrder = 6;
    group.add(sp);
  }
  return out;
}

function makeStudio() {
  const scene = new T.Scene();
  const room = new T.Mesh(new T.BoxGeometry(12, 8, 12), new T.MeshBasicMaterial({ color: 0x2b2e36, side: T.BackSide }));
  room.position.y = 2;
  scene.add(room);
  const panel = (w, h, color, intensity, pos, look) => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color, side: T.DoubleSide }));
    m.material.color.multiplyScalar(intensity);
    m.position.set(...pos);
    m.lookAt(...look);
    scene.add(m);
  };
  panel(6, 2.5, 0xffffff, 2.2, [0, 5.6, 0], [0, 0, 0]); // soft top
  panel(3, 3, 0xffe9d6, 5, [-4.5, 2.6, 4], [0, 1.2, 0]); // warm key
  panel(2, 4, 0xa9dcff, 6, [4.8, 2.4, -3.5], [0, 1.2, 0]); // cool rim
  panel(2, 3, 0xc9d9ff, 2.5, [-4.8, 2, -3.5], [0, 1.2, 0]);
  panel(8, 1.2, 0x5a4a40, 1, [0, -1.9, 0], [0, 2, 0]); // warm floor bounce
  return scene;
}

function blobTexture(soft = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (soft) {
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.62)');
    grd.addColorStop(0.7, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
  }
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

function emojiTexture(ch) {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '118px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  g.shadowColor = 'rgba(0,0,0,0.25)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillText(ch || '✨', 80, 88);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

function phoneScreenTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, 256);
  bg.addColorStop(0, '#103a5c');
  bg.addColorStop(1, '#0a1626');
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 256);
  // caller avatar ring
  g.strokeStyle = 'rgba(56,211,238,0.9)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(64, 82, 30, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(190,225,255,0.85)';
  g.beginPath();
  g.arc(64, 74, 11, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(64, 101, 19, 11, 0, Math.PI, 0);
  g.fill();
  // call pill
  g.fillStyle = '#2bd17e';
  g.beginPath();
  g.roundRect(30, 196, 68, 26, 13);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.arc(64, 209, 6, 0, Math.PI * 2);
  g.fill();
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const key of ['map', 'alphaMap', 'emissiveMap']) if (m[key] && m[key].isCanvasTexture) m[key].dispose();
      m.dispose();
    }
  });
}

// ------------------------------------------------------------------------------------------------- public facade
/**
 * Creates the 3D avatar inside `host`. Returns synchronously; the model loads in the background and fades in.
 * opts: { height = 250, prop = 'none', emoji, x = 0, facing, mood, timeScale = 1, onFail(err) }
 */
export function createAvatar3D(host, opts = {}) {
  const a = new Avatar3D(host, opts);
  const api = {
    get el() { return a.el; },
    get width() { return a._width; },
    get height() { return a._height; },
    get x() { return a._x; },
    set x(v) {
      a._x = Number(v) || 0;
      a._writeEl();
      a._wake();
    },
    get y() { return a._y; },
    set y(v) {
      a._y = Number(v) || 0;
      a._writeEl();
      a._wake();
    },
    get timeScale() { return a._ts; },
    set timeScale(v) {
      a._ts = Math.max(0, Number(v) || 0);
      a._syncAnimRates();
      a._wake();
    },
    get mood() { return a._mood; },
    get facing() { return a._facing; },
    get busy() { return !!a._action; },
    get action() { return a._action ? a._action.name : null; },
    get def() { return a._info; },
    get avatarId() { return a._info.id; },
    get is3D() { return true; },
    get prop() { return a._propId; },
    get emoji() { return a._emoji; },
    get ready() { return a._ready; },
    get is3D() { return true; },

    setFacing(f) {
      a._facing = clamp(Math.round(Number(f) || 0), -1, 1);
      a._wake();
    },

    async walkTo(x, { speed, mood } = {}) {
      const request = ++a._walkRequest;
      if (!a._ready) await a._loaded;
      if (a._destroyed || request !== a._walkRequest) return false;
      a._wake();
      if (a._loco) a._finishLoco(false);
      if (a._glide) {
        a._glide.resolve(false);
        a._glide = null;
      }
      if (a._failed) {
        a._x = x;
        a._writeEl();
        return Promise.resolve(false);
      }
      const dist = x - a._x;
      if (Math.abs(dist) < 0.5) {
        a._x = x;
        a._writeEl();
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const w = a._startWalk(x, speed, mood);
        a._loco = { kind: 'walk', dir: w.dir, to: x, speed: w.speed, v: 0, endPhase: w.endPhase, resolve, endFacing: 0 };
      });
    },

    glideTo({ x, y } = {}, { ms = 1000, ease = 'inOut', sway = 0 } = {}) {
      a._wake();
      if (a._glide) a._glide.resolve(false);
      if (a._failed || a._destroyed) {
        if (x != null) a._x = x;
        if (y != null) a._y = y;
        a._writeEl();
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        a._glide = { x0: a._x, y0: a._y, x1: x ?? a._x, y1: y ?? a._y, t0: a._clock, dur: Math.max(0.001, ms / 1000), ease: ease === 'canopy' ? canopyDescent : easeFn(ease), sway, resolve };
      });
    },

    pose(name, { duration = 450 } = {}) {
      a._wake();
      a._setPose(name, duration);
      return new Promise((res) => a._after(duration, res));
    },

    expression(name) {
      a._setExpression(name);
      a._wake();
    },

    setMood(m) {
      if (!MOOD[m]) return;
      a._mood = m;
      a._setExpression(m === 'neutral' ? 'neutral' : m);
      a._wake();
    },

    async play(name, opts = {}) {
      a._wake();
      const fn = ACTIONS3D[name];
      const exprBefore = a._action ? a._action.exprBefore : a._exprName;
      a._cancelAction();
      if (!fn || a._failed) return false;
      const token = { cancelled: false, touched: new Set(), touchedIk: new Set() };
      a._action = { name, token, exprBefore, ownsHead: false };
      const ctx = a._makeCtx(token, opts);
      try {
        await fn(ctx, opts);
      } catch (e) {
        if (e !== CANCEL) console.error(e);
      }
      if (token.cancelled) return false;
      a._action = null;
      const releaseMs = name === 'land' && opts.umbrella ? 180 : name === 'throwUmbrella' ? 380 : 620;
      a._releaseAction(releaseMs, token);
      a._setExpression(exprBefore);
      await new Promise((res) => a._after(releaseMs, res));
      return true;
    },

    /** Advances the simulation by `ms` of avatar time in 60 Hz steps (inspection / hidden captures). */
    async advance(ms, frameMs = 1000 / 60, onFrame) {
      let left = ms;
      while (left > 0 && !a._destroyed) {
        const d = Math.min(frameMs, left);
        left -= d;
        if (a._ready) a._step(d / 1000);
        if (a._ready && onFrame) onFrame(api.inspect());
        for (const an of a._anims) if (an.playState !== 'finished') an.currentTime = (an.currentTime || 0) + d;
        for (let i = 0; i < 12; i++) await null;
      }
      if (a._ready) a._render();
    },

    stop() {
      a._walkRequest++;
      a._cancelAction();
      a._clearThrown();
      a._S.hipRoll.dyn = a._S.spineRoll.dyn = a._S.aRoll.dyn = 0;
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
      if (cx == null || !a._ready) {
        a._track = null;
        return;
      }
      const r = a._canvas.getBoundingClientRect();
      if (!r.width) return;
      a._root.updateMatrixWorld(true);
      const e = a._project(_v1.copy(a._anchorsM.eye_l).lerp(a._anchorsM.eye_r, 0.5), {});
      const ex = r.left + (e.x / a._cw) * r.width;
      const ey = r.top + ((e.y + a._padTop) / a._ch) * r.height;
      // the cursor is treated as a point ~0.9 m in front of the screen plane
      const kpx = a._k * (r.height / a._ch);
      const dx = (cx - ex) / kpx;
      const dy = (cy - ey) / kpx;
      const depth = 0.9;
      // direction in world → body-relative yaw/pitch (the body may be turned)
      let yaw = Math.atan2(dx, depth) / D2R - a._yaw.v;
      let pitch = Math.atan2(dy, Math.hypot(dx, depth)) / D2R;
      const behind = Math.abs(yaw) > 95 ? 0.25 : 1;
      yaw = clamp(yaw, -55, 55) * behind;
      pitch = clamp(pitch, -22, 26);
      a._track = { x: cx, y: cy };
      a._trackLook = { yaw: yaw * 0.85, pitch: pitch * 0.8 };
    },

    fx(name, o = {}) {
      a._wake();
      if (name === 'clear') {
        for (const h of [...a._fxHandles]) h.stop();
        return { stop() {}, done: Promise.resolve() };
      }
      const h = playFx(a._fxCtx, name, o);
      a._fxHandles.add(h);
      h.done.then(() => a._fxHandles.delete(h));
      return h;
    },

    setProp(prop = 'none', emoji) {
      a._propId = PROP_IDS.includes(prop) ? prop : 'none';
      a._emoji = typeof emoji === 'string' ? emoji : '';
      if (!a._propOverride) a._mountProp();
      a._wake();
    },

    setColor(hex) {
      // Only models with tintable cloth (Kai's hoodie) react; an imported avatar keeps its own textures.
      a._color = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
      if (a._tint) a._applyTint(a._color);
      a._wake();
    },

    setAvatar() {
      // a 3D avatar stays itself; the engine facade swaps 2D ↔ 3D instances
    },

    setHeight(px) {
      a._height = Math.max(40, Number(px) || 360);
      a._applySize();
      a._wake();
    },

    anchor(name) {
      return a.anchor(name);
    },

    hitTest(cx, cy) {
      return a.hitTest(cx, cy);
    },

    on(name, cb) {
      if (!a._listeners.has(name)) a._listeners.set(name, new Set());
      a._listeners.get(name).add(cb);
      return () => a._listeners.get(name)?.delete(cb);
    },

    debug(on = true) {
      a._debugOn = !!on;
      if (a._debugEl) a._debugEl.remove();
      a._debugEl = null;
      if (!on) return;
      const el = document.createElement('div');
      el.className = 'nb-fx-layer';
      a.el.appendChild(el);
      a._debugEl = el;
      const draw = () => {
        if (!a._debugOn || a._destroyed) return;
        el.innerHTML = '';
        for (const n of ['top', 'mouth', 'eyeL', 'eyeR', 'earL', 'earR', 'chest', 'handL', 'handR', 'ground']) {
          const p = a._anchorLocal(n);
          const d = document.createElement('div');
          d.style.cssText = `position:absolute;left:${p.x - 3}px;top:${p.y - 3}px;width:6px;height:6px;border-radius:50%;background:#2B7CFF;box-shadow:0 0 0 1.5px #fff;font:9px monospace;color:#2B7CFF;white-space:nowrap`;
          d.innerHTML = `<span style="position:absolute;left:8px;top:-3px;text-shadow:0 0 2px #fff">${n}</span>`;
          el.appendChild(d);
        }
        requestAnimationFrame(draw);
      };
      draw();
    },

    /** Debug / verification probe: model-space joint positions and a few derived measurements. */
    inspect() {
      if (!a._ready) return null;
      const P = a._P;
      const v = (p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
      const out = { clock: +a._clock.toFixed(3), y: a._y, propKind: a._propKind, umbrellaOpen: a._F.umbrellaOpen, propVisible: a._F.propVis, pose: a._poseName, frames: a._frameN, timers: a._timers.length, yaw: +a._yaw.v.toFixed(1), x: a._x, gait: +a._gait.w.toFixed(2), phase: +a._gait.phase.toFixed(3) };
      for (const n of ['Hips', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftLeg', 'RightLeg', 'LeftToeBase', 'RightToeBase']) out[n] = v(P[n]);
      out.mouth = v(a._anchorsM.mouth);
      out.spout = v(a._spoutM);
      out.spoutToMouth = +a._spoutM.distanceTo(a._anchorsM.mouth).toFixed(3);
      if (a._prop && a._propRoot) {
        a._root.updateMatrixWorld(true);
        const q = new T.Quaternion();
        a._propRoot.getWorldQuaternion(q);
        const ax = new T.Vector3(0, 1, 0).applyQuaternion(q);
        out.propAxis = v(ax);
        out.wristSolve = a._wristProbe;
        if (a._propKind === 'umbrella') {
          const lo = {x:Infinity,y:Infinity}, hi = {x:-Infinity,y:-Infinity};
          const inverse = a._root.matrixWorld.clone().invert();
          const point = new T.Vector3();
          a._prop.group.traverse(mesh => {
            if (!mesh.isMesh) return;
            const positions = mesh.geometry.attributes.position;
            for (let i=0;i<positions.count;i++) {
              point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
              const projected = a._project(point, {});
              const y = projected.y + a._padTop;
              projected.x += a._padSide;
              lo.x=Math.min(lo.x,projected.x);lo.y=Math.min(lo.y,y);
              hi.x=Math.max(hi.x,projected.x);hi.y=Math.max(hi.y,y);
            }
          });
          out.propCanvasBounds = {left:lo.x,top:lo.y,right:hi.x,bottom:hi.y,width:a._cw,height:a._ch};
        }
      }
      // feet in world space (for slide checks): screen x of each ankle
      const fw = (n) => {
        const p = a._P[n].clone().applyMatrix4(a._root.matrixWorld);
        return +(a._x + (p.x * a._k) + a._width / 2).toFixed(2);
      };
      out.footScreenX = { L: fw('LeftFoot'), R: fw('RightFoot') };
      out.footY = { L: +a._P.LeftFoot.y.toFixed(3), R: +a._P.RightFoot.y.toFixed(3) };
      out.airborne = +a._air.v.toFixed(3);
      out.rootHeight = +a._root.position.y.toFixed(3);
      out.propRenderScale = a._prop?.group.scale.x;
      out.thrown = a._thrown ? {position: v(a._thrown.object.position), velocity:v(a._thrown.velocity), age:a._thrown.age} : null;
      out.rotations = {};
      for (const n of ['Hips', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg']) {
        out.rotations[n] = a._bones[n].quaternion.toArray();
      }
      return out;
    },

    destroy() {
      if (a._destroyed) return;
      api.stop();
      for (const h of [...a._fxHandles]) h.stop();
      a._destroyed = true;
      a._loadResolve(false);
      live.delete(a);
      all3d.delete(a);
      const timers = a._timers;
      a._timers = [];
      for (const timer of timers) timer.fn();
      if (a._ro) a._ro.disconnect();
      if (a._renderer) {
        if (a._propRoot) {
          for (const c of [...a._propRoot.children]) disposeTree(c);
        }
        if (a._shadow) {
          for (const m of Object.values(a._shadow)) {
            m.geometry.dispose();
            m.material.dispose();
          }
          a._shadowTex.dispose();
        }
        if (a._envRT) a._envRT.dispose();
        a._renderer.dispose();
        a._renderer.forceContextLoss();
        a._renderer = null;
        templateUsers = Math.max(0, templateUsers - 1);
      }
      a.el.remove();
      a._fxWorld.remove();
      a._listeners.clear();
    },
  };
  a._api = api;
  api.setProp(opts.prop || 'none', opts.emoji);
  api.setColor(opts.color ?? null);
  if (opts.facing) api.setFacing(opts.facing);
  return api;
}
