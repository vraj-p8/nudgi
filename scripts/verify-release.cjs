// Fresh-profile UI, Kai motion and optional local GLB import through the actual IPC bridge.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sanitizeConfig } = require('../src/main/store');
const out = path.resolve(__dirname, '../output/release');
const dir = path.join(out, `profile-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(sanitizeConfig({ settings: { launchAtLogin: false, hotkey: '', sound: false }, runtime: { onboarded: true } })));
process.env.NUDGE_USER_DATA = dir;
const errors = [];
app.on('browser-window-created', (_e, w) => w.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); }));
require('../src/main/main');
const pause = ms => new Promise(r => setTimeout(r, ms));
const run = (w, code) => w.webContents.executeJavaScript(`(async()=>{${code}})()`);
async function until(fn, label) { for (let i=0;i<150;i++) { if(await fn()) return; await pause(100); } throw new Error(label); }
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('/settings/')), 'settings');
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/settings/'));
    await until(() => run(w, 'return !!document.querySelector("#rem-cards .card")'), 'cards');
    assert.equal((await run(w, 'return await nudge.getState()')).settings.avatarId, 'nova');
    for (const width of [900, 1100]) {
      w.setSize(width, 760); await pause(300);
      assert.ok(await run(w, `return [...document.querySelectorAll('.card')].every(c=>{
        const r=c.getBoundingClientRect();return [...c.querySelectorAll('.card-actions > button, .card-actions > .menu-wrap > button')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left&&q.right<=r.right&&q.bottom<=r.bottom});});`));
    }
    await run(w, 'document.querySelector("[data-section=buddy]").click()');
    await pause(500);
    assert.deepEqual(await run(w, 'return [...document.querySelectorAll(".buddy-card")].map(e=>e.dataset.id)'), ['nova']);
    assert.ok(await run(w, 'return !document.body.textContent.includes("Use your own image")'));
    await run(w, 'document.querySelector("#avatar-guide-toggle").click()');
    await pause(300);
    fs.writeFileSync(path.join(out, 'buddy-guide.png'), (await w.webContents.capturePage()).toPNG());
    const motion = await run(w, `
      const {createAvatar}=await import('../shared/avatar-engine.js');
      const host=document.createElement('div');Object.assign(host.style,{position:'fixed',inset:'60px 0 0',background:'#eef3fa',zIndex:'99'});document.body.append(host);
      const av=createAvatar(host,{avatarId:'nova',height:360,timeScale:0,prop:'bottle'});av.x=80;av.y=10;
      await av.advance(1000);const walk=av.walkTo(620,{speed:180});const samples=[];
      for(let i=0;i<240;i++){await av.advance(1000/60);const leg=host.querySelector('[data-part=legL]');samples.push({x:av.x,transform:leg.getAttribute('transform')});}
      await walk; window.kaiMotion={av,host};
      return {positions:samples.map(s=>s.x),uniqueLegPoses:new Set(samples.map(s=>s.transform)).size,end:av.x};
    `);
    assert.equal(motion.end, 620);
    assert.ok(motion.uniqueLegPoses > 100, 'Legs must animate during walking');
    assert.ok(motion.positions.every((x,i,a)=>!i || (x>=a[i-1] && x-a[i-1]<4)), 'Walking must advance smoothly');
    await run(w, 'const av=window.kaiMotion.av;av.x=80;av.walkTo(620,{speed:180});await av.advance(1150)');
    await w.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'kai-walk.png'), (await w.webContents.capturePage()).toPNG());
    await run(w, 'window.kaiMotion.av.destroy();window.kaiMotion.host.remove()');
    const model = process.env.NUDGE_TEST_MODEL;
    if (model) {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.resolve(model)] });
      const state = await run(w, 'return await nudge.pickAvatarModel()');
      assert.equal(state.settings.avatarId, 'me3d');
      assert.ok(state.meta.avatarModelUrl.startsWith('file:'));
      assert.ok(fs.existsSync(path.join(dir, 'avatars/avatar.glb')));
      await until(() => run(w, 'return document.querySelector(".buddy-card[data-id=me3d] canvas")?.style.opacity === "1"'), 'imported 3D preview');
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({result:'PASS',motion,modelImport:!!model,errors},null,2));
    console.log('RELEASE UI / KAI WALK / LOCAL IMPORT PASS'); app.quit();
  } catch (e) { console.error(e,errors);app.exit(1); }
});
