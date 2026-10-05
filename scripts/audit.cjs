// Functional audit of the real app (isolated profile): IPC validation + persistence, reminder editing through the
// settings UI, real outcomes and stats, tray menu, summon hotkey, pause, preview variants, welcome flow.
// Run: electron scripts/audit.cjs            (main audit)
//      AUDIT_WELCOME=1 electron scripts/audit.cjs   (first-run welcome flow)
const { app, BrowserWindow, ipcMain, Tray, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeConfig } = require('../src/main/store');

const welcome = !!process.env.AUDIT_WELCOME;
const out = path.resolve(__dirname, '../output/audit');
const dataDir = path.join(out, `user-data-${welcome ? 'welcome-' : ''}${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
const HOTKEY = 'CommandOrControl+Alt+F11';
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(sanitizeConfig({
  settings: { avatarId: 'nova', userName: 'Audit', launchAtLogin: false, hotkey: HOTKEY, entrance: 'walk', sound: false, autoDismissSec: 15 },
  runtime: { onboarded: !welcome },
})));
process.env.NUDGE_USER_DATA = dataDir;
process.argv.push('--settings');
if (!welcome) process.argv.push('--demo');

// Capture the tray menu and the hotkey callback so the real handlers can be exercised.
let trayMenu = null;
const origSet = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) { trayMenu = menu; return origSet.call(this, menu); };
let hotkeyFn = null;
const origReg = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (acc, fn) => { if (acc === HOTKEY) hotkeyFn = fn; return origReg(acc, fn); };

const errors = [];
const events = [];
ipcMain.on('overlay:respond', (_e, v) => events.push({ ch: 'respond', ...v }));
ipcMain.on('overlay:done', (_e, v) => events.push({ ch: 'done', ...v }));
ipcMain.on('window:openSettings', () => events.push({ ch: 'openSettings' }));
app.on('browser-window-created', (_e, win) => win.webContents.on('console-message', (e) => {
  // X4122 is the Windows D3D shader compiler's precision note on three.js built-in shaders (benign).
  if ((e.level === 'error' || e.level === 'warning') && !/warning X4122/.test(e.message)) errors.push(`${e.level}: ${e.message}`);
}));
require('../src/main/main');

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` Ã¢â‚¬â€ ${detail}` : ''}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await pause(150); } return false; };
const readCfg = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
const doneCount = () => events.filter((e) => e.ch === 'done').length;

app.whenReady().then(async () => {
  try {
    const win = (part) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(part));
    await until(() => win('/settings/') && win('/overlay/'));
    const settings = win('/settings/');
    const overlay = win('/overlay/');
    await until(() => run(settings, 'return !!window.nudge && !!document.querySelector(".nav-item")'));
    const asking = () => until(() => run(overlay, 'return document.querySelector(".nbb-bubble")?.dataset.state === "asking"'), 30000);
    const bubbleText = () => run(overlay, 'return document.querySelector(".nbb-bubble")?.textContent.replace(/\\s+/g, " ").trim()');
    const answer = async (outcome) => { await pause(700); await run(overlay, `document.querySelector("[data-outcome=${outcome}]").click()`); };
    const waitDone = async (n) => until(() => doneCount() >= n, 45000);

    if (welcome) {
      check('welcome run appears on first launch', await asking());
      const text = await bubbleText();
      check('welcome text uses name + first reminder', /Audit/.test(text) && /drink water/i.test(text) && /45 min/.test(text), text);
      await answer('later');
      check('welcome "Customize" opens settings', await until(() => events.some((e) => e.ch === 'openSettings'), 5000));
      await waitDone(1);
      await pause(800);
      check('onboarded saved', readCfg().runtime.onboarded === true);
      const st = await run(settings, 'return await nudge.getState()');
      check('welcome answer does not touch stats', Object.keys(st.stats).length === 0, JSON.stringify(st.stats));
    } else {
      // ---- 1. real run from --demo: YES updates stats/schedule
      check('demo run appears', await asking());
      const askText = await bubbleText();
      check('bubble shows only configured text', /Hey, Audit/.test(askText) && /Did you drink water\?/.test(askText) && /YES/.test(askText) && /Remind me later/.test(askText), askText);
      const t0 = Date.now();
      await answer('yes');
      await waitDone(1);
      let st = await run(settings, 'return await nudge.getState()');
      const today = Object.values(st.stats.water || {})[0] || {};
      check('YES counted', today.yes === 1, JSON.stringify(st.stats));
      const next = st.runtime.next.water;
      check('YES schedules next Ã¢â€°Ë† every (45 min) or next window', next && next - t0 > 40 * 60000, `in ${Math.round((next - t0) / 60000)} min`);
      check('respond then done, once', events.filter((e) => e.ch === 'respond').length === 1 && events[0].outcome === 'yes', JSON.stringify(events));

      // ---- 2. tray summon Ã¢â€ â€™ LATER Ã¢â€ â€™ streak + snooze
      check('tray menu built', !!trayMenu && trayMenu.items.some((i) => /Summon/.test(i.label)), trayMenu && trayMenu.items.map((i) => i.label).join(' | '));
      await pause(21000); // main enforces a 20 s gap between real runs
      trayMenu.items.find((i) => /Summon/.test(i.label)).click();
      check('tray summon shows buddy', await asking());
      await answer('later');
      await waitDone(2);
      st = await run(settings, 'return await nudge.getState()');
      const t1 = Date.now();
      check('LATER counted', (Object.values(st.stats.water)[0] || {}).later === 1, JSON.stringify(st.stats.water));
      check('LATER streak = 1', st.runtime.laterStreak.water === 1, JSON.stringify(st.runtime.laterStreak));
      check('LATER snoozes ~15 min', Math.abs(st.runtime.next.water - t1 - 15 * 60000) < 90000, `in ${Math.round((st.runtime.next.water - t1) / 60000)} min`);

      // ---- 3. hotkey summon Ã¢â€ â€™ Ãƒâ€” dismiss
      check('hotkey registered', !!hotkeyFn);
      await pause(21000);
      if (hotkeyFn) hotkeyFn();
      check('hotkey summon shows buddy', await asking());
      const laterText = await bubbleText();
      check('streak escalation adds no words', !/Again|Ã°Å¸Â¥Âº/.test(laterText), laterText);
      await answer('dismiss');
      await waitDone(3);
      st = await run(settings, 'return await nudge.getState()');
      check('dismiss adds no stat', (Object.values(st.stats.water)[0] || {}).later === 1 && !(Object.values(st.stats.water)[0] || {}).missed, JSON.stringify(st.stats.water));

      // ---- 4. settings validation + persistence
      st = await run(settings, `return await nudge.updateSettings({ size: 'xl', volume: 7, autoDismissSec: 2, side: 'top', entrance: 'teleport', userName: '${'x'.repeat(60)}' })`);
      const s = st.settings;
      check('invalid settings sanitized', ['s', 'm', 'l'].includes(s.size) && s.volume <= 1 && s.autoDismissSec >= 15 && ['left', 'right'].includes(s.side) && ['walk', 'drop', 'peek', 'random'].includes(s.entrance) && s.userName.length <= 24, JSON.stringify({ size: s.size, volume: s.volume, auto: s.autoDismissSec, side: s.side, entrance: s.entrance, name: s.userName.length }));
      await run(settings, `return await nudge.updateSettings({ size: 'l', side: 'left', bubbleStyle: 'bubble', volume: 0.3, userName: 'Audit' })`);
      await pause(1500);
      const cs = readCfg().settings;
      check('valid settings persisted to disk', cs.size === 'l' && cs.side === 'left' && cs.bubbleStyle === 'bubble' && cs.volume === 0.3, JSON.stringify({ size: cs.size, side: cs.side, style: cs.bubbleStyle, volume: cs.volume }));

      // ---- 5. preview variant: left side, bubble style, large; bubble inside the work area
      await run(settings, 'const s = await nudge.getState(); return await nudge.testReminder(s.reminders[0])');
      check('preview (left/bubble/large) shows', await asking());
      const lay = await run(overlay, `const b = document.querySelector('.nbb-card').getBoundingClientRect(); const a = document.querySelector('.nb-avatar').getBoundingClientRect();
        return { b: [b.left, b.top, b.right, b.bottom].map(Math.round), a: [a.left, a.right].map(Math.round), W: innerWidth, H: innerHeight, style: document.querySelector('.nbb-bubble').className }`);
      check('bubble within work area', lay.b[0] >= 0 && lay.b[1] >= 0 && lay.b[2] <= lay.W && lay.b[3] <= lay.H, JSON.stringify(lay));
      check('avatar on the left side', lay.a[0] < lay.W / 2, JSON.stringify(lay.a));
      check('bubble style applied', /bubble/.test(lay.style), lay.style);
      const before = JSON.stringify((await run(settings, 'return await nudge.getState()')).stats);
      await answer('yes');
      await waitDone(4);
      check('preview YES adds no stats', JSON.stringify((await run(settings, 'return await nudge.getState()')).stats) === before);

      // ---- 6. reminders through the real settings UI
      await run(settings, 'document.querySelector("[data-section=reminders]")?.click(); document.querySelector("#rem-new").click()');
      await until(() => run(settings, 'return document.querySelectorAll(".tpl").length > 0'));
      await run(settings, '[...document.querySelectorAll(".tpl")].find((t) => /Call someone/.test(t.textContent)).click()');
      check('template creates reminder', await until(async () => (await run(settings, 'return (await nudge.getState()).reminders.length')) === 2));
      await run(settings, 'const i = document.querySelector("#f-question"); i.value = "Did you call Dad?"; i.dispatchEvent(new Event("input", { bubbles: true }))');
      check('editor autosaves', await until(async () => (await run(settings, 'return (await nudge.getState()).reminders.some((r) => r.question === "Did you call Dad?")')), 4000));
      await run(settings, 'const i = document.querySelector("#f-title"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true }))');
      await pause(900);
      const inv = await run(settings, 'return { chip: document.querySelector("#ed-save").dataset.state, err: document.querySelector("[data-field=title] .err").textContent, saved: (await nudge.getState()).reminders.find((r) => r.question === "Did you call Dad?").title }');
      check('empty title blocked with inline error', inv.chip === 'invalid' && inv.err && inv.saved === 'Call someone', JSON.stringify(inv));
      await run(settings, 'const i = document.querySelector("#f-title"); i.value = "Call Dad"; i.dispatchEvent(new Event("input", { bubbles: true }))');
      await pause(900);
      const bad = await run(settings, `const s = await nudge.getState(); const r = s.reminders[0];
        await nudge.saveReminder({ ...r, id: 'bad1', schedule: { ...r.schedule, days: [] } });
        await nudge.saveReminder({ ...r, id: 'bad2', schedule: { ...r.schedule, every: 0 } });
        await nudge.saveReminder({ ...r, id: 'bad3', schedule: { ...r.schedule, mode: 'times', times: ['25:99'] } });
        return (await nudge.getState()).reminders.filter((q) => q.id.startsWith('bad')).map((q) => ({ id: q.id, days: q.schedule.days.length, every: q.schedule.every, times: q.schedule.times }))`);
      const validTimes = (ts) => ts.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x));
      check('invalid reminders rejected or repaired', bad.every((q) => q.days > 0 && q.every >= 1 && validTimes(q.times) && q.times.length > 0), JSON.stringify(bad));
      await run(settings, `for (const id of ${JSON.stringify(bad.map((q) => q.id))}) await nudge.deleteReminder(id)`);
      const ids = await run(settings, 'return (await nudge.getState()).reminders.map((r) => r.id)');
      const callId = ids.find((id) => id !== 'water');
      st = await run(settings, `return await nudge.deleteReminder(${JSON.stringify(callId)})`);
      check('delete reminder', st.reminders.length === ids.length - 1 && !(callId in st.runtime.next));

      // ---- 7. pause / resume, reset stats
      const until30 = Date.now() + 30 * 60000;
      st = await run(settings, `return await nudge.setPause(${until30})`);
      const pausedLabel = trayMenu && trayMenu.items.map((i) => i.label).join(' | ');
      check('pause stored + tray shows it', st.runtime.pausedUntil === until30 && /Resume|Paused/.test(pausedLabel), pausedLabel);
      st = await run(settings, 'return await nudge.setPause(null)');
      check('resume clears pause', st.runtime.pausedUntil === null);
      st = await run(settings, 'return await nudge.resetStats()');
      check('reset stats', Object.keys(st.stats).length === 0);

      // ---- 7b. scheduling modes, enable toggle, size, hotkey and colour changes
      st = await run(settings, `const s = await nudge.getState(); const r = { ...s.reminders[0], id: 'times1', title: 'Times test', schedule: { ...s.reminders[0].schedule, mode: 'times', times: ['23:58'], from: '00:00', to: '00:00', days: [0,1,2,3,4,5,6] } }; return await nudge.saveReminder(r)`);
      const tn = new Date(st.runtime.next.times1);
      check('times mode schedules the next listed time', tn.getHours() === 23 && tn.getMinutes() === 58, tn.toString());
      st = await run(settings, `const s = await nudge.getState(); return await nudge.saveReminder({ ...s.reminders.find((r) => r.id === 'times1'), enabled: false })`);
      check('disabling a reminder clears its next run', st.runtime.next.times1 == null, String(st.runtime.next.times1));
      await run(settings, `return await nudge.deleteReminder('times1')`);
      const before7 = hotkeyFn;
      hotkeyFn = null;
      await run(settings, `return await nudge.updateSettings({ hotkey: 'CommandOrControl+Alt+F11' })`);
      await run(settings, `return await nudge.updateSettings({ hotkey: '' })`);
      st = await run(settings, `return await nudge.updateSettings({ hotkey: 'CommandOrControl+Alt+F11' })`);
      check('hotkey re-registers after change', !!hotkeyFn && st.settings.hotkey === 'CommandOrControl+Alt+F11');
      hotkeyFn = hotkeyFn || before7;
      for (const [size, want] of [['s', 250], ['l', 440]]) {
        await run(settings, `return await nudge.updateSettings({ size: '${size}', avatarColor: '#E4572E', side: 'right', bubbleStyle: 'comic' })`);
        await run(settings, 'const s = await nudge.getState(); return await nudge.testReminder(s.reminders[0])');
        await asking();
        const hpx = await run(overlay, 'return Math.round(document.querySelector(".nb-avatar").getBoundingClientRect().height)');
        check(`size "${size}" renders ${want}px buddy`, Math.abs(hpx - want) <= 2, `${hpx}px`);
        await answer('dismiss');
        await waitDone(doneCount() + 1);
      }

      // ---- 8. every settings section renders
      for (const sec of ['reminders', 'buddy', 'general', 'today']) {
        await run(settings, `document.querySelector("[data-section=${sec}]").click()`);
        await pause(400);
        const vis = await run(settings, `const el = document.querySelector('#sec-${sec}'); return !!el && !el.hidden && el.getBoundingClientRect().height > 50`);
        check(`settings section "${sec}" renders`, vis);
      }
    }
    check('no renderer errors or warnings', errors.length === 0, errors.slice(0, 5).join(' || '));
  } catch (err) {
    check('audit crashed', false, String(err && err.stack || err));
  }
  fs.writeFileSync(path.join(out, `results${welcome ? '-welcome' : ''}.json`), JSON.stringify({ results, events, errors }, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`AUDIT ${failed ? `FAILED (${failed})` : 'PASS'}`);
  app.exit(failed ? 1 : 0);
});
