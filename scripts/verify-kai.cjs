// Kai (2D rig) motion check: jointed gait contact, knee absorption, umbrella throw. Run: electron scripts/verify-kai.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = path.resolve(__dirname, '../output/kai');
app.setPath('userData', path.join(out, 'user-data'));
const errors = [];

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  // Offscreen rendering keeps requestAnimationFrame running without showing a window.
  const win = new BrowserWindow({ width: 1400, height: 720, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const shot = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  let ok = true;
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/dev/gallery.html'));
    await run(`
      const { createAvatar } = await import('../shared/avatar-engine.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#1b1e26';
      document.body.append(host);
      window.av = createAvatar(host, { avatarId: 'nova', flat: true, height: 320, prop: 'bottle' });
      window.foot = (side) => {
        const m = av.el.querySelector('[data-part="foot' + side + '"]').getScreenCTM();
        return (side === 'L' ? [74, 100] : [100, 126]).map((x) => new DOMPoint(x, 300).matrixTransform(m));
      };
      window.pt = (part, x, y) => new DOMPoint(x, y).matrixTransform(av.el.querySelector('[data-part="' + part + '"]').getScreenCTM());
      window.record = () => {
        const rows = [];
        let on = true;
        const tick = () => {
          if (!on) return;
          const H = pt('legL', 88, 236), K = pt('shinL', 87.6, 259), A = pt('footL', 87, 281);
          rows.push({ L: foot('L'), R: foot('R'), knee: (Math.atan2(K.x - H.x, K.y - H.y) - Math.atan2(A.x - K.x, A.y - K.y)) * 180 / Math.PI, hip: H.y });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return () => { on = false; return rows; };
      };
      av.x = 60;
      await new Promise((r) => setTimeout(r, 600));
    `);

    // 1. Walk: planted contact corners must not slide; nothing below the floor.
    const walk = await run(`
      const stop = record();
      const p = av.walkTo(1100, {});
      setTimeout(() => {}, 0);
      await new Promise((r) => setTimeout(r, 900));
      window.__mid = true;
      await p;
      await new Promise((r) => setTimeout(r, 400));
      const rows = stop();
      const ground = Math.max(...rows.flatMap((r) => [...r.L, ...r.R].map((q) => q.y)));
      const rest = rows[0].L[0].y;
      const slide = [];
      for (const s of ['L', 'R']) for (let i = 1; i < rows.length; i++) for (let c = 0; c < 2; c++) {
        const a = rows[i - 1][s][c], b = rows[i][s][c];
        if (rest - a.y < 0.5 && rest - b.y < 0.5) slide.push(Math.abs(b.x - a.x));
      }
      slide.sort((a, b) => a - b);
      const knee = rows.map((r) => r.knee);
      return { frames: rows.length, restFloor: +rest.toFixed(2), maxBelowFloor: +(ground - rest).toFixed(2),
        contactSamples: slide.length, slideP50: +(slide[slide.length >> 1] || 0).toFixed(2), slideP95: +(slide[Math.floor(slide.length * 0.95)] || 0).toFixed(2),
        kneeMin: +Math.min(...knee).toFixed(1), kneeMax: +Math.max(...knee).toFixed(1),
        maxLift: +(rest - Math.min(...rows.flatMap((r) => [...r.L, ...r.R].map((q) => q.y)))).toFixed(1) };
    `);
    console.log('WALK', JSON.stringify(walk));
    if (walk.maxBelowFloor > 0.6 || walk.slideP95 > 1.2 || walk.kneeMax < 20) ok = false;
    await run('window.__w = av.walkTo(600, {})');
    await new Promise((r) => setTimeout(r, 700));
    await shot('walk-mid');
    await run('await window.__w');

    // 2. Landing: knees absorb, feet stay put.
    const land = await run(`
      await new Promise((r) => setTimeout(r, 500));
      const stop = record();
      const p = av.play('land');
      await new Promise((r) => setTimeout(r, 120));
      window.__landMid = true;
      await p;
      const rows = stop();
      const xs = rows.map((r) => r.L[0].x);
      return { kneeMax: +Math.max(...rows.map((r) => Math.abs(r.knee))).toFixed(1), hipDrop: +(Math.max(...rows.map((r) => r.hip)) - rows[0].hip).toFixed(1),
        footDriftPx: +(Math.max(...xs) - Math.min(...xs)).toFixed(2) };
    `);
    console.log('LAND', JSON.stringify(land));
    if (land.kneeMax < 8 || land.kneeMax > 65 || land.footDriftPx > 1.5) ok = false;

    // 3. Drop entrance + ballistic umbrella throw.
    const toss = await run(`
      await av.pose('umbrella', { duration: 300 });
      av.y = 420;
      await av.glideTo({ y: 0 }, { ms: 1500, ease: 'canopy', sway: 12 });
      await av.play('land', { umbrella: true });
      const world = av.el.parentNode.querySelector('.nb-fx-world');
      const p = av.play('throwUmbrella', { dir: 1 });
      let seen = 0, path = [];
      const watch = setInterval(() => {
        const g = world && world.querySelector('svg > g');
        if (g) { seen++; const r = g.getBoundingClientRect(); path.push([Math.round(r.x), Math.round(r.y)]); }
      }, 60);
      await p;
      await new Promise((r) => setTimeout(r, 2200));
      clearInterval(watch);
      const prop = av.el.querySelector('[data-slot="prop"]');
      return { flyingSamples: seen, path: path.filter((_, i) => i % 4 === 0), removed: !(world && world.querySelector('svg')),
        propOpacity: prop ? getComputedStyle(prop).opacity : null, propMarkup: prop ? prop.innerHTML.length : 0 };
    `);
    console.log('TOSS', JSON.stringify(toss));
    if (toss.flyingSamples < 3 || !toss.removed || !(toss.propMarkup > 0)) ok = false;
    await run(`av.pose('idle', { duration: 200 }); await av.pose('present', { duration: 400 });`);
    await new Promise((r) => setTimeout(r, 500));
    await shot('present-after-throw');
  } catch (err) {
    ok = false;
    errors.push(String(err && err.stack || err));
  }
  if (errors.length) { ok = false; console.log('ERRORS', JSON.stringify(errors)); }
  console.log(ok ? 'KAI OK' : 'KAI FAILED');
  app.exit(ok ? 0 : 1);
});
