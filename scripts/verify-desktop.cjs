// Integration check using the real app, preload bridge, transparent overlay and isolated config.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sanitizeConfig } = require('../src/main/store');
const out = path.resolve(__dirname, '../output/desktop');
const dataDir = path.join(out, `user-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
const avatarId = process.env.NUDGE_TEST_AVATAR || 'nova';
if (avatarId === 'me3d') {
  if (!process.env.NUDGE_TEST_MODEL) throw new Error('Set NUDGE_TEST_MODEL to your local GLB');
  fs.mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });
  fs.copyFileSync(process.env.NUDGE_TEST_MODEL, path.join(dataDir, 'avatars/avatar.glb'));
}
const config = sanitizeConfig({ settings: { avatarId, userName: 'friend', launchAtLogin: false, hotkey: '', entrance: 'walk', sound: false, autoDismissSec: 15 }, runtime: { onboarded: true } });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
process.env.NUDGE_USER_DATA = dataDir;
process.env.NUDGE_DEBUG = '1';
process.argv.push('--demo', '--settings');
const errors = [];
const events = [];
ipcMain.on('overlay:respond', (_e, value) => events.push({ channel: 'respond', value }));
ipcMain.on('overlay:done', (_e, value) => events.push({ channel: 'done', value }));
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
});
require('../src/main/main');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const until = async (fn, label, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await pause(200); }
  throw new Error(`Timed out: ${label}; ${errors.join('\n')}`);
};
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('/settings/')), 'windows');
    const overlay = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/overlay/'));
    const settings = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/settings/'));
    await until(() => run(settings, 'return !!window.nudge && !!document.querySelector(".nav-item")'), 'settings ready');
    const state = await run(settings, 'return await nudge.getState()');
    assert.equal(state.settings.avatarId, avatarId);
    const shot = async (name) => {
      const rect = await run(overlay, `const els = [...document.querySelectorAll('.nb-avatar, .nbb-card')];
        const boxes = els.map(el => el.getBoundingClientRect());
        const x = Math.max(0, Math.floor(Math.min(...boxes.map(r => r.left)) - 30));
        const y = Math.max(0, Math.floor(Math.min(...boxes.map(r => r.top)) - 30));
        return {x, y, width: Math.min(innerWidth-x, Math.ceil(Math.max(...boxes.map(r => r.right))-x+30)), height: Math.min(innerHeight-y, Math.ceil(Math.max(...boxes.map(r => r.bottom))-y+30))};`);
      fs.writeFileSync(path.join(out, `${name}.png`), (await overlay.webContents.capturePage(rect)).toPNG());
    };
    const asking = () => until(() => run(overlay, 'return document.querySelector(".nbb-bubble")?.dataset.state === "asking" && !!document.querySelector(".nb-avatar")'), '3D asking');
    const done = async (count) => {
      try { await until(() => events.filter((e) => e.channel === 'done').length >= count, 'exit complete', 45000); }
      catch (error) { console.error('OVERLAY', await run(overlay, 'return (await import("./overlay.js")).inspectOverlay()')); throw error; }
    };
    await asking();
    await pause(3500);
    let frameRate = null;
    if (avatarId === 'me3d') {
    const beforeFrame = await run(overlay, 'return (await import("./overlay.js")).inspectOverlay().rig');
    await pause(1000);
    const afterFrame = await run(overlay, 'return (await import("./overlay.js")).inspectOverlay().rig');
    frameRate = (afterFrame.frames-beforeFrame.frames)/(afterFrame.clock-beforeFrame.clock);
    assert.ok(frameRate > 30 && frameRate < 160, `unexpected animation rate: ${frameRate}`);
    }
    const layout = await run(overlay, 'const r = document.querySelector(".nbb-card").getBoundingClientRect(); return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:innerWidth, height:innerHeight, text:document.querySelector(".nbb-bubble").textContent}');
    assert.ok(layout.left >= 0 && layout.top >= 0 && layout.right <= layout.width && layout.bottom <= layout.height, 'bubble clips outside work area');
    await shot('walk-ask');
    await run(overlay, 'document.querySelector("[data-outcome=yes]").click()');
    await pause(1800); await shot('yes-drink'); await done(1);
    console.log('DESKTOP walk / YES / exit PASS');
    await run(settings, 'await nudge.updateSettings({ entrance: "drop" }); const s = await nudge.getState(); return await nudge.testReminder(s.reminders[0])');
    await asking(); await shot('drop-ask');
    await run(overlay, 'document.querySelector("[data-outcome=later]").click()');
    await pause(1000); await shot('later-sad'); await done(2);
    console.log('DESKTOP drop / LATER / exit PASS');
    await run(settings, 'await nudge.updateSettings({ entrance: "peek" }); const s = await nudge.getState(); return await nudge.testReminder(s.reminders[0])');
    await asking(); await shot('peek-ask'); await done(3);
    console.log('DESKTOP peek / TIMEOUT / exit PASS');
    await run(settings, 'document.querySelector("[data-section=buddy]").click()');
    await until(() => run(settings, 'return !!document.querySelector(".buddy-card[data-id=nova] svg")'), 'buddy card visible');
    await pause(600);
    assert.equal(await run(settings, `return document.querySelector('.buddy-pick[data-value=${avatarId}]').getAttribute('aria-checked')`), 'true');
    fs.writeFileSync(path.join(out, 'settings-buddy.png'), (await settings.webContents.capturePage()).toPNG());
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ frameRate, layout, events, errors, result: 'PASS' }, null, 2));
    console.log('DESKTOP VERIFICATION PASS');
    app.quit();
  } catch (error) { console.error(error, errors); app.exit(1); }
});
