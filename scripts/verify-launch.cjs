// Exercise normal launch, quiet login, and reopening with an isolated profile.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sanitizeConfig } = require('../src/main/store');
const out = path.resolve(__dirname, '../output/launch');
const dir = path.join(out, `profile-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(sanitizeConfig({ settings: { launchAtLogin: false, hotkey: '' }, runtime: { onboarded: true } })));
process.env.NUDGE_USER_DATA = dir;
const background = process.argv.includes('--background');
require('../src/main/main');
const pause = ms => new Promise(r => setTimeout(r, ms));
const settings = () => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/settings/'));
async function ready() {
  for (let i = 0; i < 100; i++) {
    const w = settings();
    if (w?.isVisible() && await w.webContents.executeJavaScript('!!document.querySelector("#rem-cards .card")')) return w;
    await pause(100);
  }
  throw new Error('Settings did not open');
}
app.whenReady().then(async () => {
  try {
    if (background) {
      await pause(1200);
      assert.equal(settings(), undefined, 'Login must stay quiet');
      app.emit('second-instance', {}, [process.execPath]);
    }
    let w = await ready();
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      w.setSize(900, 620);
      await pause(500);
      const metrics = await w.webContents.executeJavaScript(`(() => {
        const img = document.querySelector('.nav-brand img');
        const hint = document.querySelector('.reopen-hint').getBoundingClientRect();
        return { loaded: img.complete && img.naturalWidth > 0, width: img.clientWidth, hintBottom: hint.bottom, height: innerHeight };
      })()`);
      assert.ok(metrics.loaded && metrics.width === 88);
      assert.ok(metrics.hintBottom <= metrics.height, 'Reopen instructions clipped');
      fs.writeFileSync(path.join(out, `${background ? 'background' : 'normal'}-${theme}.png`), (await w.webContents.capturePage()).toPNG());
    }
    w.close();
    app.emit('second-instance', {}, [process.execPath]);
    w = await ready();
    assert.ok(w.isVisible());
    console.log(`PASS: ${background ? 'quiet login' : 'normal launch'}, light/dark logo, minimum window size, close/reopen`);
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
