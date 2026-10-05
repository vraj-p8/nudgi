// Dev tool: drive the real app, answer YES and capture the celebration frame by frame.
// PowerShell: $env:NUDGE_TEST_AVATAR="me3d"; $env:NUDGE_TEST_MODEL="<local glb>"; electron scripts/capture-yes.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeConfig } = require('../src/main/store');

const avatarId = process.env.NUDGE_TEST_AVATAR || 'nova';
const out = path.resolve(__dirname, '../output/yes', avatarId);
const dataDir = path.join(out, `user-data-${Date.now()}`);
fs.mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });
if (avatarId === 'me3d') fs.copyFileSync(process.env.NUDGE_TEST_MODEL, path.join(dataDir, 'avatars/avatar.glb'));
const config = sanitizeConfig({
  settings: { avatarId, userName: 'friend', launchAtLogin: false, hotkey: '', entrance: 'walk', sound: false, autoDismissSec: 30 },
  runtime: { onboarded: true },
});
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
process.env.NUDGE_USER_DATA = dataDir;
process.argv.push('--demo');
const errors = [];
let done = false;
ipcMain.on('overlay:done', () => { done = true; });
app.on('browser-window-created', (_e, win) => win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); }));
require('../src/main/main');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
app.whenReady().then(async () => {
  let overlay;
  for (let i = 0; i < 150 && !overlay; i++) {
    overlay = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/overlay/'));
    await pause(200);
  }
  for (let i = 0; i < 200; i++) {
    if (await run(overlay, 'return document.querySelector(".nbb-bubble")?.dataset.state === "asking"').catch(() => false)) break;
    await pause(200);
  }
  await pause(1500);
  const rect = await run(overlay, `const r = document.querySelector('.nb-avatar').getBoundingClientRect();
    const x = Math.max(0, Math.floor(r.left - 220)), y = Math.max(0, Math.floor(r.top - 330));
    return { x, y, width: Math.min(innerWidth - x, Math.ceil(r.width + 440)), height: Math.min(innerHeight - y, Math.ceil(r.bottom - y + 10)) };`);
  await run(overlay, 'document.querySelector("[data-outcome=yes]").click()');
  const t0 = Date.now();
  let n = 0;
  while (!done && Date.now() - t0 < 16000) {
    fs.writeFileSync(path.join(out, `f${String(n++).padStart(3, '0')}.png`), (await overlay.webContents.capturePage(rect)).toPNG());
    await pause(120);
  }
  console.log(JSON.stringify({ avatarId, frames: n, ms: Date.now() - t0, errors }));
  app.exit(0);
});
