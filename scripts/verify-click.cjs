// Real-input check: moves your actual cursor and clicks the bubble's buttons over several consecutive runs. This is
// the path the JavaScript-click checks cannot cover: Windows hit-testing, click-through toggling and clicks on a
// window that never takes focus. A tinted backdrop under the overlay catches any click that falls through.
// Run: electron scripts/verify-click.cjs   (keep your hands off the mouse for about a minute)
// PowerShell: $env:NUDGE_TEST_AVATAR="me3d"; $env:NUDGE_TEST_MODEL="<local glb>" to use an imported avatar.
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitizeConfig } = require('../src/main/store');

const ANSWERS = ['yes', 'later', 'yes', 'dismiss']; // run 2 onward is where a re-shown overlay used to drop clicks
const out = path.resolve(__dirname, '../output/click');
const dataDir = path.join(out, `user-data-${Date.now()}`);
fs.mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });
const avatarId = process.env.NUDGE_TEST_AVATAR || 'nova';
if (avatarId === 'me3d') {
  if (!process.env.NUDGE_TEST_MODEL) throw new Error('Set NUDGE_TEST_MODEL to your local GLB');
  fs.copyFileSync(process.env.NUDGE_TEST_MODEL, path.join(dataDir, 'avatars/avatar.glb'));
}
const HOTKEY = 'CommandOrControl+Alt+F10';
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(sanitizeConfig({
  settings: { avatarId, userName: 'Click', launchAtLogin: false, hotkey: HOTKEY, entrance: 'walk', sound: false, voice: false,
    size: 'l', side: 'right', autoDismissSec: 30 },
  runtime: { onboarded: true },
})));
process.env.NUDGE_USER_DATA = dataDir;

let hotkeyFn = null;
const origReg = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (acc, fn) => { if (acc === HOTKEY) hotkeyFn = fn; return origReg(acc, fn); };

const responses = [];
let done = 0;
ipcMain.on('overlay:respond', (_e, v) => responses.push(v.outcome));
ipcMain.on('overlay:done', () => done++);
require('../src/main/main');

// SendInput helper (absolute moves in 0..65535 over the primary display, left button down/up), driven over stdin.
const MOUSE_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class NudgiMouse {
  [StructLayout(LayoutKind.Sequential)] struct MI { public int dx, dy, data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct IN { public int type; public MI mi; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, IN[] i, int size);
  public static void Send(int dx, int dy, int flags) {
    var a = new IN[1]; a[0].mi.dx = dx; a[0].mi.dy = dy; a[0].mi.flags = flags;
    if (SendInput(1, a, Marshal.SizeOf(typeof(IN))) != 1) throw new Exception("SendInput failed");
  }
}
"@
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Split(' ')
  switch ($p[0]) { 'move' { [NudgiMouse]::Send([int]$p[1], [int]$p[2], 0x8001) } 'down' { [NudgiMouse]::Send(0, 0, 2) } 'up' { [NudgiMouse]::Send(0, 0, 4) } }
  [Console]::Out.WriteLine('OK')
}`;

const results = [];
const check = (name, pass, detail = '') => { results.push(!!pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await pause(100); } return false; };
const js = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);

app.whenReady().then(async () => {
  const home = screen.getCursorScreenPoint();
  const mouse = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(MOUSE_PS, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let acks = '';
  mouse.stdout.on('data', (d) => (acks += d));
  const send = async (line) => { const n = acks.split('OK').length; mouse.stdin.write(`${line}\n`); await until(() => acks.split('OK').length > n, 3000); };
  const bounds = screen.getPrimaryDisplay().bounds;
  const moveTo = (x, y) => send(`move ${Math.round(((x - bounds.x) * 65536) / bounds.width)} ${Math.round(((y - bounds.y) * 65536) / bounds.height)}`);
  const park = { x: bounds.x + 160, y: bounds.y + Math.round(bounds.height * 0.3) };
  let backdrop = null;
  try {
    if (!(await until(() => acks.includes('READY'), 20000))) throw new Error('mouse helper did not start');
    await moveTo(park.x, park.y); // the overlay opens on the display under the cursor: keep it on the primary one

    const area = screen.getPrimaryDisplay().workArea;
    backdrop = new BrowserWindow({ ...area, show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true,
      alwaysOnTop: true, resizable: false, backgroundColor: '#00000000' });
    await backdrop.loadURL('data:text/html,<body style="margin:0;height:100vh;background:rgba(40,40,70,.16)"><script>window.hits=0;addEventListener("mousedown",()=>hits++)</script>');
    backdrop.showInactive();

    const overlay = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/overlay/'));
    if (!(await until(() => overlay() && hotkeyFn))) throw new Error('overlay or hotkey not ready');
    const ov = overlay();
    let ignoring = true;
    const origIgnore = ov.setIgnoreMouseEvents.bind(ov);
    ov.setIgnoreMouseEvents = (ignore, opts) => { ignoring = ignore; return origIgnore(ignore, opts); };

    for (const [i, outcome] of ANSWERS.entries()) {
      const label = `run ${i + 1} (${outcome})`;
      const before = responses.length;
      const doneBefore = done;
      hotkeyFn();
      const sel = outcome === 'dismiss' ? '.nbb-close' : `[data-outcome=${outcome}]`;
      const ready = await until(() => js(ov, `const b = document.querySelector('[data-outcome=yes]'); // the × only shows on hover
        return document.querySelector('.nbb-bubble')?.dataset.state === 'asking' && !!b && !b.closest('.nbb-pending') && getComputedStyle(b).opacity === '1';`));
      if (!ready) { check(`${label}: bubble asks`, false); break; }
      await pause(1500);
      const r = await js(ov, `const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
      const wb = ov.getBounds();
      const target = { x: wb.x + r.x, y: wb.y + r.y };
      for (let s = 1; s <= 24; s++) { // a quick, human-like glide that decelerates onto the button
        const f = 1 - (1 - s / 24) ** 3;
        await moveTo(park.x + (target.x - park.x) * f, park.y + (target.y - park.y) * f);
        await pause(12);
      }
      await pause(350);
      check(`${label}: hovering makes the overlay clickable`, !ignoring);
      const hits = await js(backdrop, 'return hits');
      await send('down'); await pause(50); await send('up');
      const answered = await until(() => responses.length > before, 2000);
      check(`${label}: real click answers`, answered && responses[before] === outcome, responses.slice(before).join(',') || 'no answer');
      check(`${label}: no click fell through`, (await js(backdrop, 'return hits')) === hits);
      await moveTo(park.x, park.y);
      if (!(await until(() => done > doneBefore, 45000))) { check(`${label}: run finishes`, false); break; }
      await pause(600);
    }
  } catch (err) {
    check('click check ran', false, err.message);
  } finally {
    await moveTo(home.x, home.y).catch(() => {});
    mouse.stdin.end();
    backdrop?.destroy();
    const failed = results.filter((p) => !p).length;
    console.log(`${results.length - failed}/${results.length} passed`);
    app.exit(failed ? 1 : 0);
  }
});
