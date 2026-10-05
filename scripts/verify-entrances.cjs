// Real-app entrance/branding checks with a separate profile; samples the rendered rig on every frame.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sanitizeConfig } = require('../src/main/store');
const out = path.resolve(__dirname, '../output/entrances');
const dataDir = path.join(out, `user-data-${Date.now()}`);
fs.mkdirSync(path.join(dataDir, 'avatars'), { recursive: true });
if (!process.env.NUDGE_TEST_MODEL) throw new Error('Set NUDGE_TEST_MODEL to your local GLB');
fs.copyFileSync(process.env.NUDGE_TEST_MODEL, path.join(dataDir, 'avatars/avatar.glb'));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(sanitizeConfig({ settings: {
  avatarId: 'me3d', userName: 'friend', launchAtLogin: false, hotkey: '', entrance: 'drop', size: 'm', sound: false, autoDismissSec: 0,
}, runtime: { onboarded: true } })));
process.env.NUDGE_USER_DATA = dataDir;
process.argv.push('--settings');
const errors = [], events = [], results = [];
ipcMain.on('overlay:done', (_e, value) => events.push(value));
app.on('browser-window-created', (_e, win) => win.webContents.on('console-message', e => {
  if (e.level === 'error') errors.push(e.message);
}));
require('../src/main/main');
const pause = ms => new Promise(r => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await pause(70); }
  throw new Error(`Timed out: ${label}; ${errors.join('\n')}`);
}
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('/settings/')), 'settings');
    const settings = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/settings/'));
    const overlay = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/overlay/'));
    await until(() => run(settings, 'return !!window.nudge && !!document.querySelector(".nav-item")'), 'settings ready');
    assert.equal(app.getName(), 'Nudgi');
    assert.equal(settings.getTitle(), 'Nudgi');
    assert.equal(await run(settings, 'return document.querySelector(".nav-brand strong").textContent'), 'Nudgi');
    assert.ok(await run(settings, 'const m=document.querySelector(".nav-brand img"); await m.decode(); return m.naturalWidth>0 && m.src.endsWith("icon.png")'));
    await until(() => run(settings, 'return !!document.querySelector("#rem-cards .card")'), 'reminders rendered');
    await pause(650);
    fs.writeFileSync(path.join(out, 'nudgi-settings.png'), (await settings.webContents.capturePage()).toPNG());
    // Save a focused crop at each meaningful stage, including the canopy above the head.
    const shot = async name => {
      const rect = await run(overlay, `const c=document.querySelector('.nb-avatar canvas'); const r=c.getBoundingClientRect();
        const x=Math.max(0,Math.floor(r.left-30)),y=Math.max(0,Math.floor(r.top-15));
        return {x,y,width:Math.min(innerWidth-x,Math.ceil(r.right-x+30)),height:Math.min(innerHeight-y,Math.ceil(r.bottom-y+20))};`);
      fs.writeFileSync(path.join(out, `${name}.png`), (await overlay.webContents.capturePage(rect)).toPNG());
    };
    for (const scenario of [
      { entrance: 'drop', side: 'right', size: 'm' },
      { entrance: 'walk', side: 'left', size: 'm' },
      { entrance: 'peek', side: 'right', size: 'm' },
      { entrance: 'drop', side: 'left', size: 'l' },
      { entrance: 'peek', side: 'left', size: 's' },
      { entrance: 'walk', side: 'right', size: 'l' },
      { entrance: 'drop', side: 'right', size: 's' },
    ]) {
      const name = `${scenario.entrance}-${scenario.side}-${scenario.size}`;
      await run(overlay, `window.entranceFrames=[]; window.entranceSampling=true;
        const inspect=(await import('./overlay.js')).inspectOverlay;
        const sample=()=>{if(!window.entranceSampling)return;const f=inspect();if(f.phase&&f.rig){const c=document.querySelector('.nb-avatar canvas'),r=c?.getBoundingClientRect();f.visible=c&&c.parentElement.style.visibility!=='hidden'&&r.right>0&&r.left<innerWidth;window.entranceFrames.push(f);}requestAnimationFrame(sample)};requestAnimationFrame(sample);`);
      await run(settings, `await nudge.updateSettings(${JSON.stringify(scenario)}); const s=await nudge.getState(); await nudge.testReminder(s.reminders[0]);`);
      if (scenario.entrance === 'drop') {
        await until(() => run(overlay, `const p=(await import('./overlay.js')).inspectOverlay().rig;return p?.propKind==='umbrella'&&p.y>100&&p.y<innerHeight*.45`), `${name} flight`);
        await shot(`${name}-flight`);
        await until(() => run(overlay, `const f=(await import('./overlay.js')).inspectOverlay();return f.action==='land'&&f.rig?.y===10`), `${name} touchdown`);
        await shot(`${name}-touchdown`);
        await until(() => run(overlay, `const p=(await import('./overlay.js')).inspectOverlay().rig;return p?.thrown?.age>.15`), `${name} throw`);
        await shot(`${name}-throw`);
      }
      await until(() => run(overlay, 'return document.querySelector(".nbb-bubble")?.dataset.state === "asking"'), `${name} asking`);
      await pause(650);
      await shot(`${name}-arrived`);
      const frames = await run(overlay, 'window.entranceSampling=false;return window.entranceFrames');
      fs.writeFileSync(path.join(out, `${name}-frames.json`), JSON.stringify(frames));
      let maxJointRate=0,maxXStep=0,minToe=Infinity,maxClipping=0,lastEnter;
      for(let i=1;i<frames.length;i++) {
        const prev=frames[i-1].rig, f=frames[i].rig, dt=f.clock-prev.clock;
        if(dt<=0)continue;
        if(frames[i].phase==='enter'&&frames[i].visible&&frames[i-1].visible) {
          maxXStep=Math.max(maxXStep,Math.abs(f.x-prev.x)); lastEnter=f;
          if(f.propCanvasBounds) {
            const b=f.propCanvasBounds;
            maxClipping=Math.max(maxClipping,-b.left,-b.top,b.right-b.width,b.bottom-b.height);
          }
          if(f.y<=12)minToe=Math.min(minToe,f.LeftToeBase[1],f.RightToeBase[1]);
          for(const key of Object.keys(f.rotations)) {
            const dot=Math.abs(f.rotations[key].reduce((s,v,j)=>s+v*prev.rotations[key][j],0));
            maxJointRate=Math.max(maxJointRate,2*Math.acos(Math.min(1,dot))*180/Math.PI/dt);
          }
        }
      }
      const landed=frames.filter(f=>f.phase==='enter'&&f.rig.y<=12&&f.rig.propKind==='umbrella');
      const summary={...scenario,frames:frames.length,maxJointDegreesPerSecond:+maxJointRate.toFixed(2),maxHorizontalStepPx:+maxXStep.toFixed(2),minGroundToeMetres:minToe===Infinity?null:minToe,landedUmbrellaFrames:landed.length,maxCanvasClippingPx:maxClipping};
      assert.ok(frames.length>100, `${name}: missing samples`);
      assert.ok(maxJointRate<800, `${name}: joint snaps ${maxJointRate}`);
      assert.ok(minToe>-.01, `${name}: foot penetrates floor ${minToe}`);
      if(scenario.entrance==='drop') {
        assert.ok(landed.length>20,'umbrella disappeared before landing and throw');
        const flight=frames.filter(f=>f.rig.propKind==='umbrella'&&f.rig.y>12);
        for(let i=1;i<flight.length;i++) assert.ok(flight[i].rig.y<=flight[i-1].rig.y+.01,'descent reverses');
        assert.ok(maxXStep<3,'sway snaps horizontally');
        assert.ok(maxClipping<.5,`umbrella clipped by canvas: ${maxClipping}px`);
        const thrown=frames.filter(f=>f.rig.thrown);
        assert.ok(thrown.length>10,'umbrella never leaves the hand');
        const direction=scenario.side==='left'?-1:1;
        for(let i=1;i<thrown.length;i++) {
          assert.ok(direction*(thrown[i].rig.thrown.position[0]-thrown[i-1].rig.thrown.position[0])>=0,'throw travels in wrong direction');
          assert.ok(thrown[i].rig.thrown.velocity[1]<=thrown[i-1].rig.thrown.velocity[1],'throw ignores gravity');
        }
        const releaseClock=thrown[0].rig.clock;
        const bottleReveal=frames.find(f=>f.rig.clock>releaseClock&&f.rig.propKind==='bottle'&&f.rig.propVisible>.05);
        assert.ok(bottleReveal&&bottleReveal.rig.RightHand[1]<1.2,'bottle appears before hand reaches hip');
        for(const f of frames.filter(f=>f.rig.clock>releaseClock&&f.rig.propKind==='bottle')) assert.equal(f.rig.propRenderScale,1,'bottle changes physical size');
        summary.bottleRevealHandHeight=bottleReveal.rig.RightHand[1];
        summary.thrownFrames=thrown.length;
        summary.enterSeconds=+(frames.findLast(f=>f.phase==='enter').rig.clock-frames.find(f=>f.phase==='enter').rig.clock).toFixed(2);
      }
      assert.equal(frames.at(-1).rig.propKind,'bottle','reminder prop was not restored');
      results.push(summary);console.log(name,JSON.stringify(summary));
      const doneCount=events.length;
      await run(overlay, 'document.querySelector("[data-outcome=later]").click()');
      await until(()=>events.length>doneCount,`${name} exit`);
    }
    assert.equal(errors.length,0,errors.join('\n'));
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({branding:'Nudgi',results,events,errors,result:'PASS'},null,2));
    console.log('ENTRANCES / BRANDING VERIFICATION PASS');app.quit();
  } catch(error) {console.error(error,errors);app.exit(1);}
});
