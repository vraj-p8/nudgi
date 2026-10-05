// Nova — the default buddy: a cozy, hoodie-wearing young adult with fluffy espresso hair.
// Reference implementation of the avatar contract (see the header of ../avatar-engine.js).
// Pure data: the engine drives every data-part / data-variant / data-jiggle element.

const ribs = (x0, x1, y0, y1, step) => {
  let d = '';
  for (let x = x0; x <= x1 + 0.01; x += step) d += `M${x.toFixed(1)},${y0}V${y1}`;
  return d;
};
const mirrorX = (d) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (m, x, y) => `${(200 - Number(x)).toFixed(2).replace(/\.?0+$/, '')},${y}`);

// Smooth closed path through points (Catmull-Rom → cubic Bézier).
const smooth = (pts) => {
  const n = pts.length;
  const f = (v) => v.toFixed(2);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
  }
  return `${d} Z`;
};
// A tapered hair clump along a quadratic centreline root → ctrl → tip (soft rounded tip, widest near the root).
const clump = (root, ctrl, tip, w0, wTip = 1.8, n = 9) => {
  const L = [];
  const R = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * root[0] + 2 * u * t * ctrl[0] + t * t * tip[0];
    const y = u * u * root[1] + 2 * u * t * ctrl[1] + t * t * tip[1];
    const dx = 2 * u * (ctrl[0] - root[0]) + 2 * t * (tip[0] - ctrl[0]);
    const dy = 2 * u * (ctrl[1] - root[1]) + 2 * t * (tip[1] - ctrl[1]);
    const len = Math.hypot(dx, dy) || 1;
    const w = (wTip + (w0 - wTip) * u ** 0.75 * Math.min(1, 0.72 + t * 2.2)) / 2;
    L.push([x - (dy / len) * w, y + (dx / len) * w]);
    R.push([x + (dy / len) * w, y - (dx / len) * w]);
  }
  return smooth([...L, ...R.reverse()]);
};

const P = 'var(--nb-primary)';
const S = 'var(--nb-secondary)';
const mix = (c, w, pct) => `color-mix(in oklab, ${c}, ${w} ${pct}%)`;

// ----------------------------------------------------------------------------------------------- shapes
const SLEEVE_UP = 'M58.6,170 C58,160 64,155.6 70.5,155.6 C77,155.6 82.2,160.4 81.6,168 L77,199 C76.6,205 71.6,209.4 66,209.4 C60.4,209.4 55.6,205 55.6,199 Z';
const SLEEVE_LO = 'M55.4,199 C55.4,193 60.5,188.8 66,188.8 C71.5,188.8 76.6,193 76.6,199 L75.4,219 L56.6,219 Z';
const CUFF = 'M56.8,217.4 L75.2,217.4 L74.6,226.2 C74.5,227.8 73.4,228.8 71.8,228.8 L60.2,228.8 C58.6,228.8 57.5,227.8 57.4,226.2 Z';
// Thigh and shin overlap through a rounded knee so a bend never opens a gap.
const THIGH = 'M76,226 L100,226 C100.3,240 99.8,252 98.7,261 C98,268.2 77,268.2 76.6,261 C75.7,252 75.5,240 76,226 Z';
const SHIN = 'M77,257.5 C77.3,250.4 98.5,250.4 98.8,257.5 C98.5,262 97.5,265.6 96.6,268 L95.8,277 L78.4,277 L77.6,268 C77.2,264.8 76.9,261.2 77,257.5 Z';
const LEG_CUFF = 'M77.8,270.2 L96.4,270.2 L95.6,278.4 C95.5,279.5 94.7,280.2 93.6,280.2 L80.4,280.2 C79.3,280.2 78.5,279.5 78.4,278.4 Z';
const SOLE = 'M72.6,290.4 C72.4,296.4 75,300 79.6,300 L93.4,300 C98,300 100.6,296.4 100.4,290.4 Z';
const UPPER = 'M73.4,291.4 C72.4,282.2 78.2,275.8 86.5,275.8 C94.8,275.8 100.6,282.2 99.6,291.4 Z';
const HOODIE = 'M88,161 C82,161 76,160.2 72,162 C64,165 60,172 60,182 L58.6,236 C58.4,242 60,246 64,247 L136,247 C140,246 141.6,242 141.4,236 L140,182 C140,172 136,165 128,162 C124,160.2 118,161 112,161 C108.6,167.6 91.4,167.6 88,161 Z';
const FACE = 'M100,46 C131,46 153,66 153,98 C153,128 133,151 100,151 C67,151 47,128 47,98 C47,66 69,46 100,46 Z';
// Fluffy back volume (behind the face), lumpy cap over the skull and swoopy fringe clumps sweeping right.
// Back volume as overlapping puffs: one flat gradient, so the union reads as a single fluffy cloud.
const HAIR_PUFFS = [
  [100, 51, 38], [72, 40, 24], [128, 39, 25], [100, 26, 17], [54, 60, 20], [147, 59, 21], [44.5, 81, 14], [156, 80, 15],
  [45, 99, 9.5], [155.5, 98, 10],
];
const HAIR_BACK = HAIR_PUFFS.map(([x, y, r]) => `M${x - r},${y} a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0 Z`).join(' ');
const HAIR_CAP = smooth([
  [46, 96], [40.5, 82], [41, 67], [47, 53], [57, 41], [69, 32], [83, 25.5], [98, 22.5], [113, 23], [127, 27], [140, 34.5],
  [151, 45], [158, 58], [160.5, 72], [158, 86], [152, 96], [144, 76], [128, 66], [100, 62], [72, 66], [56, 78],
]);
// [root, ctrl, tip, rootWidth, tipWidth] — drawn back to front, so clumps nearer the parting overlap the next one.
const CLUMPS = [
  [[148, 62], [161, 82], [153.5, 101], 18, 3.4], // right temple lock
  [[54, 62], [41, 80], [49, 98], 16, 3.4], // left temple lock
  [[112, 40], [149, 48], [150.5, 87], 30, 3.6], // outer right swoop
  [[96, 40], [127, 50], [129.5, 81], 28, 3.6], // swoop over the right brow
  [[82, 42], [109, 52], [106, 89], 30, 3.6], // big centre swoop between the eyes
  [[72, 44], [87, 58], [84.5, 79], 22, 3.2], // left inner
  [[64, 48], [57, 63], [58, 83], 18, 3.2], // left outer flick
];
// A soft sheen stroke along the upper part of a clump's centreline.
const sheen = ([root, ctrl, tip]) => {
  const pt = (t) => {
    const u = 1 - t;
    return `${(u * u * root[0] + 2 * u * t * ctrl[0] + t * t * tip[0]).toFixed(1)},${(u * u * root[1] + 2 * u * t * ctrl[1] + t * t * tip[1]).toFixed(1)}`;
  };
  return `M${pt(0.2)} Q${pt(0.34)} ${pt(0.5)}`;
};
const FRINGE = CLUMPS.map(([r, c, t, w0, w1]) => {
  const d = clump(r, c, t, w0, w1);
  return `<path d="${d}" transform="translate(0.8 1.5)" fill="#140B07" opacity="0.24"/><path d="${d}" fill="url(#nova-hair)"/>` +
    `<path d="${sheen([r, c, t])}" fill="none" stroke="#FFE6D3" stroke-opacity="0.13" stroke-width="3.2" stroke-linecap="round"/>`;
}).join('');
const COWLICK = 'M103.6,21 C100.6,11 106,1.5 116,1.5 C124,1.5 127.6,8 123.4,12.6 C124.4,7.6 120,4.8 115.6,5.8 C110,7 108.4,13 110.6,20.6 Z';
const HEART = 'M0,8.5 C-8.5,3 -11,-2 -11,-5.5 C-11,-9.5 -7.8,-12 -4.8,-12 C-2.6,-12 -0.9,-10.8 0,-9 C0.9,-10.8 2.6,-12 4.8,-12 C7.8,-12 11,-9.5 11,-5.5 C11,-2 8.5,3 0,8.5 Z';
const GRIN = 'M91,124.2 Q100,125.4 109,124.2 Q108.4,136 100,136.4 Q91.6,136 91,124.2 Z';

const INK = '#2A1712';
const LIP = '#6B2B22';
const MOUTH_IN = '#5E1F1A';
const TONGUE = '#F2797A';

// One eye of the open set (whites, lid shade, irises in the pupils group live in the caller).
const eyeWhite = (cx) => `<ellipse cx="${cx}" cy="104.4" rx="11.4" ry="12.8" fill="url(#nova-eyewhite)"/>`;
const iris = (cx, cy = 105) =>
  `<circle cx="${cx}" cy="${cy}" r="10.4" fill="url(#nova-iris)"/>` +
  `<path d="M${cx - 8},${cy + 3.8} A8.9,8.9 0 0 0 ${cx + 8},${cy + 3.8} A10.4,10.4 0 0 1 ${cx - 8},${cy + 3.8} Z" fill="#CD8A56" opacity="0.6"/>` +
  `<circle cx="${cx}" cy="${cy + 0.6}" r="4.7" fill="#120A06"/>` +
  `<ellipse cx="${cx + 3.9}" cy="${cy - 4.4}" rx="3.6" ry="4" fill="#FFFFFF"/>` +
  `<circle cx="${cx - 4}" cy="${cy + 4.6}" r="1.8" fill="#FFFFFF" opacity="0.9"/>`;
// Upper lid: a tapered dark crescent with a little outer wing (reads as lashes, never as an outline).
const LASH = 'M66.6,102 C66.6,93.6 72.4,90 79,90 C85.6,90 91.2,93.4 91.4,101 C89.6,96.4 85.2,94 79,94 C72.8,94 68.4,96.8 66.6,102 Z M67.6,98.2 L63.2,95.6 L66.4,100.4 Z';
const lash = (side) => `<path d="${side === 'L' ? LASH : mirrorX(LASH)}" fill="${INK}"/>`;
const lidShade = (cx) => `<ellipse cx="${cx}" cy="94.5" rx="13" ry="5.5" fill="url(#nova-lidshade)"/>`;

// Hand pieces (L hand drawn at its rest position; R mirrored).
const handOpen = (cx, thumbX, thumbRot) =>
  `<ellipse cx="${cx}" cy="232.6" rx="8.4" ry="8.8" fill="url(#nova-hand)"/>` +
  `<ellipse cx="${thumbX}" cy="229.6" rx="3" ry="4.4" transform="rotate(${thumbRot} ${thumbX} 229.6)" fill="url(#nova-hand)"/>` +
  `<path d="M${cx - 4.5},236.6 C${cx - 2.5},238.7 ${cx + 1.5},239.1 ${cx + 3.9},237.7" stroke="#B16E46" stroke-opacity="0.45" stroke-width="1" fill="none" stroke-linecap="round"/>`;

const sleeve = (mirror) => {
  const m = mirror ? mirrorX : (d) => d;
  return `<path d="${m(SLEEVE_UP)}" fill="url(#nova-sleeve)"/>` +
    `<path d="${m('M60.5,171 C64.5,166.5 75.5,165.5 80.8,169.5')}" fill="none" style="stroke: ${mix(P, 'black', 32)}" stroke-width="1" opacity="0.55"/>` +
    `<path d="${m('M61.4,180 C60.4,190 60,196 60.4,203')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="3" stroke-linecap="round"/>`;
};
const forearm = (mirror) => {
  const m = mirror ? mirrorX : (d) => d;
  return `<path d="${m(SLEEVE_LO)}" fill="url(#nova-sleeve)"/>` +
    `<path d="${m('M58.6,204 C58.2,209 58.2,213 58.8,217')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.13" stroke-width="2.6" stroke-linecap="round"/>` +
    `<path d="${m(CUFF)}" style="fill: ${mix(P, 'black', 17)}"/>` +
    `<path d="${m(ribs(59.4, 72.6, 219, 227.4, 2.2))}" style="stroke: ${mix(P, 'black', 36)}" stroke-width="0.8" stroke-opacity="0.45"/>` +
    `<path d="${m('M57.2,218.6 L74.8,218.6')}" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="1"/>`;
};

const leg = (mirror) => {
  const m = mirror ? mirrorX : (d) => d;
  const g = mirror ? 'nova-jogR' : 'nova-jogL';
  const shin = mirror ? 'shinR' : 'shinL';
  const foot = mirror ? 'footR' : 'footL';
  return (
    // thigh (hip joint) → shin (knee) → sneaker (ankle)
    `<path d="${m(THIGH)}" fill="url(#${g})"/>` +
    `<path d="${m(THIGH)}" fill="url(#nova-hemshade)"/>` +
    `<path d="${m('M77.4,240 C76.9,249 77,256 77.6,262')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="1.3" stroke-linecap="round"/>` +
    `<g data-part="${shin}">` +
    `<g data-part="${foot}">` +
    // chunky sneaker
    `<path d="${m(SOLE)}" fill="url(#nova-sole)"/>` +
    `<path d="${m('M74.2,294.9 L98.8,294.9')}" stroke="#2EC5DA" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="${m(UPPER)}" fill="url(#nova-shoe)"/>` +
    `<path d="${m('M73.8,290.4 C80.2,292.4 92.8,292.4 99.2,290.4')}" fill="none" stroke="#C2CBD6" stroke-width="1"/>` +
    `<rect x="${mirror ? 200 - 80.6 - 11.8 : 80.6}" y="277.4" width="11.8" height="9.6" rx="3.2" fill="#E6EBF1"/>` +
    `<path d="${m('M82.8,281.2 L90.4,281.2 M82.8,284.4 L90.4,284.4')}" stroke="#B5C0CE" stroke-width="1.2" stroke-linecap="round"/>` +
    `<ellipse cx="${mirror ? 200 - 80 : 80}" cy="286.4" rx="4.6" ry="2.3" fill="#FFFFFF" opacity="0.95"/>` +
    `<path d="${m('M94.4,288.6 C96.6,287.4 97.8,285.4 98,283.2')}" fill="none" stroke="#C9D2DD" stroke-width="1.1" stroke-linecap="round"/>` +
    `</g>` +
    // jogger shin
    `<path d="${m(SHIN)}" fill="url(#${g})"/>` +
    `<path d="${m(SHIN)}" fill="url(#nova-hemshade)"/>` +
    `<path d="${m('M77.7,262 C77.9,265.6 78.3,268.8 79,272')}" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="1.3" stroke-linecap="round"/>` +
    `<path d="${m('M78.4,267.4 C83,270 91.6,270 96.4,267.4')}" fill="none" stroke="#000000" stroke-opacity="0.2" stroke-width="1.2" stroke-linecap="round"/>` +
    `<path d="${m(LEG_CUFF)}" style="fill: ${mix(S, 'black', 22)}"/>` +
    `<path d="${m(ribs(80.6, 93.8, 271.6, 279, 2.2))}" stroke="#000000" stroke-opacity="0.25" stroke-width="0.8"/>` +
    `</g>`
  );
};

const drawstring = (x) =>
  `<g data-jiggle="hang" data-pivot="${x} 171">` +
  `<path d="M${x + 0.6},171.8 C${x - 0.2},181 ${x + 1.4},191 ${x + 0.2},200.6" fill="none" stroke="#000000" stroke-opacity="0.16" stroke-width="2.6" stroke-linecap="round"/>` +
  `<path d="M${x},171 C${x - 0.9},180 ${x + 0.7},190 ${x - 0.4},199.6" fill="none" stroke="#F6F1E7" stroke-width="2.4" stroke-linecap="round"/>` +
  `<rect x="${x - 1.85}" y="199" width="3" height="7.6" rx="1.4" fill="url(#nova-metal)"/>` +
  `<rect x="${x - 1.2}" y="200" width="0.9" height="5.4" rx="0.45" fill="#FFFFFF" opacity="0.8"/>` +
  `</g>`;

// ----------------------------------------------------------------------------------------------- svg
const svg = `
<defs>
  <radialGradient id="nova-skin" gradientUnits="userSpaceOnUse" cx="90" cy="86" r="78" fx="84" fy="78">
    <stop offset="0" stop-color="#F0BA92"/><stop offset="0.5" stop-color="#E2A47A"/><stop offset="1" stop-color="#C47F55"/>
  </radialGradient>
  <radialGradient id="nova-hand" cx="0.38" cy="0.32" r="0.78">
    <stop offset="0" stop-color="#EEB68D"/><stop offset="0.6" stop-color="#DC9C71"/><stop offset="1" stop-color="#BD7A51"/>
  </radialGradient>
  <linearGradient id="nova-neck" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#9A5836"/><stop offset="0.55" stop-color="#B8754C"/><stop offset="1" stop-color="#C98A60"/>
  </linearGradient>
  <linearGradient id="nova-finger" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#EDB48B"/><stop offset="0.65" stop-color="#DA9A6F"/><stop offset="1" stop-color="#B7744C"/>
  </linearGradient>
  <radialGradient id="nova-ear" cx="0.4" cy="0.4" r="0.7">
    <stop offset="0" stop-color="#E7AA80"/><stop offset="1" stop-color="#BF7B51"/>
  </radialGradient>
  <linearGradient id="nova-hair" gradientUnits="userSpaceOnUse" x1="0" y1="10" x2="0" y2="102">
    <stop offset="0" stop-color="#4E3529"/><stop offset="0.55" stop-color="#3A271D"/><stop offset="1" stop-color="#2A1B14"/>
  </linearGradient>
  <radialGradient id="nova-hair-rim" gradientUnits="userSpaceOnUse" cx="100" cy="62" r="66">
    <stop offset="0.72" stop-color="#140B07" stop-opacity="0"/><stop offset="1" stop-color="#140B07" stop-opacity="0.45"/>
  </radialGradient>
  <radialGradient id="nova-hair-vol" gradientUnits="userSpaceOnUse" cx="84" cy="40" r="60">
    <stop offset="0" stop-color="#7A5442" stop-opacity="0.85"/><stop offset="0.6" stop-color="#5A3D2E" stop-opacity="0.25"/><stop offset="1" stop-color="#4A3226" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="nova-forehead" cx="0.5" cy="0.35" r="0.6">
    <stop offset="0" stop-color="#8A4626" stop-opacity="0.32"/><stop offset="1" stop-color="#8A4626" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="nova-eyewhite" cx="0.5" cy="0.62" r="0.62">
    <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.75" stop-color="#F5F7FA"/><stop offset="1" stop-color="#D9E0EA"/>
  </radialGradient>
  <linearGradient id="nova-iris" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1A0E08"/><stop offset="0.55" stop-color="#3D2315"/><stop offset="1" stop-color="#8C5434"/>
  </linearGradient>
  <radialGradient id="nova-lidshade" cx="0.5" cy="0.3" r="0.7">
    <stop offset="0" stop-color="#4A2A1C" stop-opacity="0.32"/><stop offset="1" stop-color="#4A2A1C" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="nova-cheek" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#FF7C78" stop-opacity="0.5"/><stop offset="1" stop-color="#FF7C78" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="nova-blush" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#FF4F78" stop-opacity="0.72"/><stop offset="0.6" stop-color="#FF6A88" stop-opacity="0.34"/><stop offset="1" stop-color="#FF6A88" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="nova-heart" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FF7AA0"/><stop offset="1" stop-color="#E9265C"/>
  </linearGradient>
  <linearGradient id="nova-hoodie" gradientUnits="userSpaceOnUse" x1="58" y1="0" x2="142" y2="0">
    <stop offset="0" style="stop-color: ${mix(P, 'black', 26)}"/>
    <stop offset="0.2" style="stop-color: ${mix(P, 'white', 8)}"/>
    <stop offset="0.52" style="stop-color: ${P}"/>
    <stop offset="0.84" style="stop-color: ${mix(P, 'black', 12)}"/>
    <stop offset="1" style="stop-color: ${mix(P, 'black', 30)}"/>
  </linearGradient>
  <linearGradient id="nova-sleeve" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" style="stop-color: ${mix(P, 'black', 26)}"/>
    <stop offset="0.38" style="stop-color: ${mix(P, 'white', 6)}"/>
    <stop offset="1" style="stop-color: ${mix(P, 'black', 24)}"/>
  </linearGradient>
  <linearGradient id="nova-hood" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" style="stop-color: ${mix(P, 'white', 6)}"/>
    <stop offset="1" style="stop-color: ${mix(P, 'black', 28)}"/>
  </linearGradient>
  <radialGradient id="nova-ao" gradientUnits="userSpaceOnUse" cx="100" cy="160" r="40">
    <stop offset="0" stop-color="#061217" stop-opacity="0.42"/><stop offset="0.6" stop-color="#061217" stop-opacity="0.12"/><stop offset="1" stop-color="#061217" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="nova-jogL" gradientUnits="userSpaceOnUse" x1="76" y1="0" x2="100" y2="0">
    <stop offset="0" style="stop-color: ${mix(S, 'black', 8)}"/>
    <stop offset="0.38" style="stop-color: ${mix(S, 'white', 14)}"/>
    <stop offset="1" style="stop-color: ${mix(S, 'black', 32)}"/>
  </linearGradient>
  <linearGradient id="nova-jogR" gradientUnits="userSpaceOnUse" x1="100" y1="0" x2="124" y2="0">
    <stop offset="0" style="stop-color: ${mix(S, 'black', 32)}"/>
    <stop offset="0.6" style="stop-color: ${mix(S, 'white', 12)}"/>
    <stop offset="1" style="stop-color: ${mix(S, 'black', 10)}"/>
  </linearGradient>
  <linearGradient id="nova-hemshade" gradientUnits="userSpaceOnUse" x1="0" y1="240" x2="0" y2="264">
    <stop offset="0" stop-color="#000000" stop-opacity="0.42"/><stop offset="1" stop-color="#000000" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="nova-shoe" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.7" stop-color="#F0F3F7"/><stop offset="1" stop-color="#D3DAE3"/>
  </linearGradient>
  <linearGradient id="nova-sole" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F5F7FA"/><stop offset="1" stop-color="#C5CED9"/>
  </linearGradient>
  <linearGradient id="nova-metal" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#7F8A9A"/><stop offset="0.45" stop-color="#F4F7FB"/><stop offset="1" stop-color="#77828F"/>
  </linearGradient>
  <clipPath id="nova-eyeclip"><ellipse cx="79" cy="104.4" rx="11.4" ry="12.8"/><ellipse cx="121" cy="104.4" rx="11.4" ry="12.8"/></clipPath>
  <clipPath id="nova-hoodieclip"><path d="${HOODIE}"/></clipPath>
  <clipPath id="nova-grinclip"><path d="${GRIN}"/></clipPath>
</defs>

<g data-part="body">
  <g data-part="legL">${leg(false)}</g>
  <g data-part="legR">${leg(true)}</g>

  <g data-part="torso">
    <!-- bunched hood behind the neck -->
    <path d="M70.5,170 C67.5,156 81,145.5 100,145.5 C119,145.5 132.5,156 129.5,170 C124,163.4 113,160.4 100,160.4 C87,160.4 76,163.4 70.5,170 Z" fill="url(#nova-hood)"/>
    <path d="M75.5,166 C79.5,158.4 89,155 100,155 C111,155 120.5,158.4 124.5,166 C118.6,162.2 110,160.4 100,160.4 C90,160.4 81.4,162.2 75.5,166 Z" style="fill: ${mix(P, 'black', 45)}" opacity="0.75"/>
    <path d="M71.6,163.6 C74.6,153.4 86,148.6 100,148.6 C114,148.6 125.4,153.4 128.4,163.6" fill="none" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="100" cy="154" rx="27" ry="6" style="fill: ${mix(P, 'black', 55)}" opacity="0.35"/>
    <!-- neck -->
    <path d="M91.5,134 L108.5,134 L108.5,166 C108.5,169 105,171 100,171 C95,171 91.5,169 91.5,166 Z" fill="url(#nova-neck)"/>
    <!-- hoodie body -->
    <path d="${HOODIE}" fill="url(#nova-hoodie)"/>
    <g clip-path="url(#nova-hoodieclip)">
      <ellipse cx="100" cy="163" rx="46" ry="21" fill="url(#nova-ao)"/>
      <path d="M66.5,178 C64.6,200 64.6,220 66.4,238" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="7" stroke-linecap="round"/>
      <path d="M135,180 C136.4,200 136.4,222 135,240" fill="none" stroke="#000000" stroke-opacity="0.08" stroke-width="6" stroke-linecap="round"/>
    </g>
    <path d="M86.4,160.4 C90.6,169.8 109.4,169.8 113.6,160.4" fill="none" style="stroke: ${mix(P, 'black', 20)}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M87.6,159.6 C91.8,167.6 108.2,167.6 112.4,159.6" fill="none" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="1" stroke-linecap="round"/>
    <!-- kangaroo pocket -->
    <path d="M74.5,237 L77.4,215 C77.9,211.4 80.2,209.6 83.8,209.6 L116.2,209.6 C119.8,209.6 122.1,211.4 122.6,215 L125.5,237 Z" style="fill: ${mix(P, 'black', 6)}"/>
    <path d="M77.5,214.2 C78.1,211.2 80.4,209.6 83.8,209.6 L116.2,209.6 C119.6,209.6 121.9,211.2 122.5,214.2" fill="none" style="stroke: ${mix(P, 'black', 34)}" stroke-width="1.1" stroke-opacity="0.65"/>
    <path d="M80.4,235.6 L82.8,216.8 M119.6,235.6 L117.2,216.8" style="stroke: ${mix(P, 'black', 42)}" stroke-width="2.2" stroke-linecap="round" stroke-opacity="0.55"/>
    <path d="M81.6,236 L84,217.4 M118.4,236 L116,217.4" stroke="#FFFFFF" stroke-width="0.9" stroke-linecap="round" stroke-opacity="0.18"/>
    <path d="M81,212.6 L119,212.6" stroke="#FFFFFF" stroke-opacity="0.24" stroke-width="0.8" stroke-dasharray="1.6 1.6"/>
    <!-- hem ribbing -->
    <path d="M60.2,238 L139.8,238 L140.2,243 C140.2,246 138,248 135,248 L65,248 C62,248 59.8,246 59.8,243 Z" style="fill: ${mix(P, 'black', 15)}"/>
    <path d="${ribs(63, 137, 239.4, 246.8, 2.6)}" style="stroke: ${mix(P, 'black', 38)}" stroke-width="0.8" stroke-opacity="0.38"/>
    <path d="M60.6,239.2 L139.4,239.2" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="1"/>
    <!-- eyelets + drawstrings (pendulums) -->
    <circle cx="92.6" cy="171" r="2" fill="url(#nova-metal)"/><circle cx="92.6" cy="171" r="0.9" fill="#4F5A69"/>
    <circle cx="107.4" cy="171" r="2" fill="url(#nova-metal)"/><circle cx="107.4" cy="171" r="0.9" fill="#4F5A69"/>
    ${drawstring(92.6)}
    ${drawstring(107.4)}

    <g data-part="armL">
      ${sleeve(false)}
      <g data-part="forearmL">
        <g data-part="handL">
        <g data-variant="handL:open">${handOpen(64.5, 71.4, -24)}</g>
        <g data-variant="handL:thumb">
          <rect x="57" y="225.6" width="15" height="13.4" rx="5.6" fill="url(#nova-hand)"/>
          <path d="M58.6,230 L66,230 M58.6,233.4 L66,233.4 M58.8,236.6 L65.4,236.6" stroke="#A9653F" stroke-opacity="0.45" stroke-width="1" stroke-linecap="round"/>
          <rect x="65.4" y="233.6" width="6.4" height="13.8" rx="3.2" fill="url(#nova-hand)"/>
          <ellipse cx="68.6" cy="244.6" rx="1.7" ry="1.2" fill="#F6CDAE" opacity="0.7"/>
        </g>
        </g>
        ${forearm(false)}
      </g>
    </g>

    <g data-part="head">
      <g data-parallax="-3" data-jiggle="bounce" data-pivot="100 72" data-amount="0.7">
        <path d="${HAIR_BACK}" fill="url(#nova-hair)"/>
        <path d="${HAIR_BACK}" fill="url(#nova-hair-rim)"/>
      </g>
      <g data-parallax="1">
        <ellipse cx="47" cy="111" rx="8.4" ry="10.6" fill="url(#nova-ear)"/>
        <ellipse cx="48.4" cy="111.6" rx="4.2" ry="6.4" fill="#B56E46" opacity="0.55"/>
        <ellipse cx="153" cy="111" rx="8.4" ry="10.6" fill="url(#nova-ear)"/>
        <ellipse cx="151.6" cy="111.6" rx="4.2" ry="6.4" fill="#B56E46" opacity="0.55"/>
      </g>
      <path d="${FACE}" fill="url(#nova-skin)"/>
      <path d="M58,134 C70,148 86,152.5 100,152.5 C114,152.5 130,148 142,134 C130,146 115,150 100,150 C85,150 70,146 58,134 Z" fill="#9A5532" opacity="0.18"/>
      <ellipse cx="100" cy="74" rx="50" ry="17" fill="url(#nova-forehead)" data-parallax="3"/>

      <g data-part="face">
        <ellipse cx="66" cy="121.5" rx="10.5" ry="6.4" fill="url(#nova-cheek)"/>
        <ellipse cx="134" cy="121.5" rx="10.5" ry="6.4" fill="url(#nova-cheek)"/>

        <g data-variant="eyes:open">
          ${eyeWhite(79)}${eyeWhite(121)}
          <g clip-path="url(#nova-eyeclip)">
            <g data-part="pupils">${iris(79)}${iris(121)}</g>
            ${lidShade(79)}${lidShade(121)}
          </g>
          ${lash('L')}${lash('R')}
        </g>
        <g data-variant="eyes:happy">
          <path d="M69.5,107 C72,98.4 86,98.4 88.5,107" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
          <path d="M111.5,107 C114,98.4 128,98.4 130.5,107" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
        </g>
        <g data-variant="eyes:closed">
          <path d="M69,103.5 C73,110 85,110 89,103.5" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>
          <path d="M70.8,106.8 L67.8,109.2" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M111,103.5 C115,110 127,110 131,103.5" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>
          <path d="M129.2,106.8 L132.2,109.2" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
        </g>
        <g data-variant="eyes:sad">
          <g clip-path="url(#nova-eyeclip)">
            ${eyeWhite(79)}${eyeWhite(121)}
            ${iris(79, 108.6)}${iris(121, 108.6)}
            <circle cx="75" cy="113.6" r="2.2" fill="#FFFFFF" opacity="0.85"/><circle cx="117" cy="113.6" r="2.2" fill="#FFFFFF" opacity="0.85"/>
            <path d="M64,84 L94,84 L94,97.4 L64,104.4 Z" fill="url(#nova-skin)"/>
            <path d="M106,84 L136,84 L136,104.4 L106,97.4 Z" fill="url(#nova-skin)"/>
          </g>
          <path d="M91.2,97.6 Q80,98.6 67.2,103.6" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
          <path d="M108.8,97.6 Q120,98.6 132.8,103.6" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
        </g>
        <g data-variant="eyes:love">
          <g transform="translate(79 106)"><path d="${HEART}" fill="url(#nova-heart)"/><ellipse cx="-4.6" cy="-6.4" rx="2.8" ry="2" fill="#FFFFFF" opacity="0.9" transform="rotate(-30 -4.6 -6.4)"/></g>
          <g transform="translate(121 106)"><path d="${HEART}" fill="url(#nova-heart)"/><ellipse cx="-4.6" cy="-6.4" rx="2.8" ry="2" fill="#FFFFFF" opacity="0.9" transform="rotate(-30 -4.6 -6.4)"/></g>
        </g>
        <g data-variant="eyes:wink">
          ${eyeWhite(79)}
          <g clip-path="url(#nova-eyeclip)">${iris(79)}${lidShade(79)}</g>
          ${lash('L')}
          <path d="M111.5,106 C114,98 128,98 130.5,106" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
        </g>

        <g data-variant="brows:neutral">
          <path d="M70,84.5 Q78.5,80.6 87,83.2 M113,83.2 Q121.5,80.6 130,84.5" fill="none" stroke="#3A2519" stroke-width="2.7" stroke-linecap="round"/>
        </g>
        <g data-variant="brows:sad">
          <path d="M70,85.6 Q79,85 87.4,80.6 M112.6,80.6 Q121,85 130,85.6" fill="none" stroke="#3A2519" stroke-width="2.7" stroke-linecap="round"/>
        </g>
        <g data-variant="brows:raised">
          <path d="M70,81 Q78.5,76 87,79 M113,79 Q121.5,76 130,81" fill="none" stroke="#3A2519" stroke-width="2.7" stroke-linecap="round"/>
        </g>

        <ellipse cx="100" cy="116.6" rx="2.7" ry="1.8" fill="#B26C45" opacity="0.42"/>
        <ellipse cx="100.9" cy="115.6" rx="1.1" ry="0.7" fill="#FFFFFF" opacity="0.55"/>

        <g data-variant="mouth:smile">
          <path d="M93,125 Q100,131.4 107,125" fill="none" stroke="${LIP}" stroke-width="2.5" stroke-linecap="round"/>
        </g>
        <g data-variant="mouth:grin">
          <path d="${GRIN}" fill="${MOUTH_IN}"/>
          <g clip-path="url(#nova-grinclip)">
            <ellipse cx="100" cy="134.4" rx="5.6" ry="3.2" fill="${TONGUE}"/>
            <rect x="92.6" y="122.8" width="14.8" height="3.6" rx="1.4" fill="#FFFFFF"/>
          </g>
        </g>
        <g data-variant="mouth:sad">
          <path d="M93.5,130.5 Q100,124.6 106.5,130.5" fill="none" stroke="${LIP}" stroke-width="2.5" stroke-linecap="round"/>
        </g>
        <g data-variant="mouth:o">
          <ellipse cx="100" cy="128.6" rx="4.4" ry="5.1" fill="${MOUTH_IN}"/>
          <ellipse cx="100" cy="131.4" rx="2.9" ry="1.7" fill="${TONGUE}"/>
        </g>
        <g data-variant="mouth:flat">
          <path d="M94.5,127.6 Q100,129 105.5,127.6" fill="none" stroke="${LIP}" stroke-width="2.4" stroke-linecap="round"/>
        </g>

        <g data-part="blush">
          <ellipse cx="65" cy="121.5" rx="11.5" ry="7" fill="url(#nova-blush)"/>
          <ellipse cx="135" cy="121.5" rx="11.5" ry="7" fill="url(#nova-blush)"/>
          <path d="M60.4,121.6 l2.2,-3.4 M64.6,122 l2.2,-3.4 M68.8,122.4 l2.2,-3.4 M131.2,122.4 l2.2,-3.4 M135.4,122 l2.2,-3.4 M139.6,121.6 l2.2,-3.4" stroke="#FF6F8E" stroke-width="1.1" stroke-linecap="round" opacity="0.75"/>
        </g>
      </g>

      <g data-parallax="3.5" data-jiggle="bounce" data-pivot="100 50" data-amount="0.55">
        <path d="${HAIR_CAP}" fill="url(#nova-hair)"/>
        <path d="${HAIR_CAP}" fill="url(#nova-hair-vol)"/>
        ${FRINGE}
        <path d="M62,52 C70,41 84,34 98,32 M108,31.6 C118,31.8 128,35 136,41" fill="none" stroke="#FFE3CF" stroke-opacity="0.13" stroke-width="7" stroke-linecap="round"/>
        <path d="M68,46.4 C75,40 84,36.4 92,35 M111,33.4 C118,33.8 124,36 129,39" fill="none" stroke="#FFEADB" stroke-opacity="0.38" stroke-width="1.8" stroke-linecap="round"/>
        <g data-jiggle="spring" data-pivot="107 20">
          <path d="${COWLICK}" fill="url(#nova-hair)"/>
          <path d="M108,16 C107,9 111,5 117,4.4" fill="none" stroke="#FFE6D3" stroke-opacity="0.28" stroke-width="1.4" stroke-linecap="round"/>
        </g>
      </g>
    </g>

    <g data-part="armR">
      ${sleeve(true)}
      <g data-part="forearmR">
        <g data-part="handR">${handOpen(135.5, 128.6, 24)}</g>
        ${forearm(true)}
        <g data-slot="prop"/>
        <g data-part="grip">
          <ellipse cx="143.4" cy="231.6" rx="6.6" ry="9.6" fill="url(#nova-hand)"/>
          ${[223.8, 228.8, 233.8, 238.8].map((y, i) => `<rect x="${127.6 + i * 0.6}" y="${y - 2.6}" width="${18 - i * 0.8}" height="5.4" rx="2.7" fill="url(#nova-finger)"/>`).join('')}
          <ellipse cx="145.6" cy="227.6" rx="2" ry="4" fill="#F6CDAE" opacity="0.4"/>
        </g>
      </g>
    </g>
  </g>
</g>`;

export default {
  id: 'nova',
  name: 'Kai',
  tagline: 'Hoodie-wearing desk buddy',
  locomotion: 'walk',
  colors: { primary: '#2BB3A3', secondary: '#26324D', accent: '#FF8A5B' },
  pivots: {
    body: [100, 300], torso: [100, 236], head: [100, 152], face: [100, 112],
    armL: [70, 166], forearmL: [66, 199], armR: [130, 166], forearmR: [134, 199],
    legL: [88, 236], legR: [112, 236], shinL: [87.6, 259], shinR: [112.4, 259], footL: [87, 281], footR: [113, 281],
    handL: [64.5, 224.5], handR: [135.5, 224.5],
  },
  anchors: {
    top: [100, 12], mouth: [100, 128], earR: [153, 111], earL: [47, 111], chest: [100, 190],
    handL: [64.5, 232], handR: [135.5, 232], eyeL: [79, 104], eyeR: [121, 104], ground: [100, 300],
  },
  tuning: { faceTurn: 7, pupil: [4, 3.4], stride: 0.82 },
  svg,
};
