// Dev tool: records the full reminder moment (entrance → ask → YES → celebration → exit) as timestamped frames for
// the README preview. PowerShell: $env:NUDGE_TEST_AVATAR="me3d"; $env:NUDGE_TEST_MODEL="<local glb>";
// electron scripts/capture-readme.cjs   → output/readme/frames/*.png + timing.json
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeConfig } = require('../src/main/store');

const avatarId = process.env.NUDGE_TEST_AVATAR || 'nova';
const out = path.resolve(__dirname, '../output/readme');
const frames = path.join(out, 'frames');
const dataDir = path.join(out, `user-data-${Date.now()}`);
fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });
if (avatarId === 'me3d') fs.copyFileSync(process.env.NUDGE_TEST_MODEL, path.join(dataDir, 'avatars/avatar.glb'));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(sanitizeConfig({
  settings: { avatarId, userName: process.env.NUDGE_TEST_NAME || 'Vraj', launchAtLogin: false, hotkey: '', entrance: 'walk', side: 'right', size: 'm', sound: false, autoDismissSec: 60 },
  runtime: { onboarded: true },
})));
process.env.NUDGE_USER_DATA = dataDir;
process.argv.push('--demo');
let done = false;
ipcMain.on('overlay:done', () => { done = true; });
require('../src/main/main');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`).catch(() => null);
app.whenReady().then(async () => {
  let overlay;
  for (let i = 0; i < 150 && !overlay; i++) {
    overlay = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/overlay/'));
    await pause(100);
  }
  // wait until the overlay is on screen, then record continuously
  for (let i = 0; i < 300 && !overlay.isVisible(); i++) await pause(50);
  // optional crop (JSON {x,y,width,height}) keeps capture fast enough for a smooth preview
  const rect = process.env.NUDGE_CAPTURE_RECT ? JSON.parse(process.env.NUDGE_CAPTURE_RECT) : undefined;
  const timing = [];
  const t0 = Date.now();
  let answered = false;
  let askingSince = 0;
  while (!done && Date.now() - t0 < 30000) {
    const img = await overlay.webContents.capturePage(rect);
    const t = Date.now() - t0;
    fs.writeFileSync(path.join(frames, `f${String(timing.length).padStart(4, '0')}.png`), img.toPNG());
    timing.push(t);
    if (!answered) {
      const asking = await run(overlay, 'return document.querySelector(".nbb-bubble")?.dataset.state === "asking"');
      if (asking && !askingSince) askingSince = t;
      if (askingSince && t - askingSince > 1600) {
        await run(overlay, 'document.querySelector("[data-outcome=yes]").click()');
        answered = true;
      }
    }
    await pause(4);
  }
  fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify(timing));
  console.log(JSON.stringify({ avatarId, frames: timing.length, ms: Date.now() - t0 }));
  app.exit(0);
});
