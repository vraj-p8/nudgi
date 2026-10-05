// Dev tool: screenshot a settings section from a fresh profile (bundled Kai only) for the docs.
//   electron scripts/capture-settings.cjs [section]   →  docs/images/<section>-settings.png (buddy → buddy-guide.png)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeConfig } = require('../src/main/store');

const section = process.argv.find((a) => /^(reminders|buddy|general|today)$/.test(a)) || 'buddy';
const out = path.resolve(__dirname, '../docs/images', section === 'buddy' ? 'buddy-guide.png' : `${section}-settings.png`);
const dataDir = path.resolve(__dirname, '../output/settings-shot', `user-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(sanitizeConfig({
  settings: { avatarId: 'nova', userName: 'Alex', launchAtLogin: false, hotkey: '', sound: false },
  runtime: { onboarded: true },
})));
process.env.NUDGE_USER_DATA = dataDir;
process.argv.push('--settings');
require('../src/main/main');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/settings/'));
    await pause(150);
  }
  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  for (let i = 0; i < 100 && !(await run('return !!document.querySelector(".nav-item")').catch(() => false)); i++) await pause(150);
  await run(`document.querySelector('[data-section=${section}]').click()`);
  await pause(5000); // let the 3D buddy cards load and settle into their idle
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log('saved', out);
  app.exit(0);
});
