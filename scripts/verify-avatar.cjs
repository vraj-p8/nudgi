// Real Chromium/WebGL verification. Run: electron scripts/verify-avatar.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve(__dirname, '../output/avatar');
app.setPath('userData', path.join(out, 'user-data'));
app.disableHardwareAcceleration();
const errors = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1120, height: 780, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const shot = async (name) => {
    // Hidden windows commit their compositor frame on capture. Flush the previous frame first.
    await run('for (const c of document.querySelectorAll(".nb-avatar-3d canvas")) { c.style.transition = "none"; c.style.opacity = "1"; }');
    await win.webContents.capturePage();
    await pause(150);
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  fs.mkdirSync(out, { recursive: true });
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/dev/avatar3d.html'));
    for (let i = 0; i < 300 && !await run('return !!window.avatarLab?.ready'); i++) await pause(100);
    assert.equal(await run('return window.avatarLab?.ready'), true, `3D load failed: ${errors.join('\n')}`);
    await run('avatarLab.timeScale = 0; avatarLab.pose("present"); await avatarLab.advance(1500)');
    await pause(500);
    await shot('present');
    const present = await run('return avatarLab.inspect()');
    console.log('PRESENT', JSON.stringify(present));
    await run('window.drinking = avatarLab.play("drink"); await avatarLab.advance(1700)');
    await shot('drink');
    console.log('DRINK', JSON.stringify(await run('return avatarLab.inspect()')));
    await run('await avatarLab.advance(12000); await window.drinking');
    const actions = await run('return (await import("../shared/avatar-3d.js")).ACTIONS_3D');
    const props = await run('return (await import("../shared/avatar-engine.js")).PROPS.map(p => p.id)');
    for (const prop of props) {
      await run(`avatarLab.setProp(${JSON.stringify(prop)}, '💧'); await avatarLab.advance(100)`);
      assert.equal(await run('return avatarLab.prop'), prop);
    }
    const actionQuality = {};
    for (const action of actions) {
      const result = await run(`window.actionDone = false; window.actionResult = null;
        avatarLab.setProp(${JSON.stringify(action === 'call' ? 'phone' : action === 'drink' ? 'bottle' : 'none')});
        let previous = avatarLab.inspect(), maxStep = 0, maxAt = null;
        avatarLab.play(${JSON.stringify(action)}).then(r => { window.actionDone = true; window.actionResult = r; });
        await avatarLab.advance(20000, 1000/60, frame => {
          for (const name of Object.keys(frame.rotations)) {
            const dot = Math.abs(frame.rotations[name].reduce((sum,v,j)=>sum+v*previous.rotations[name][j],0));
            const step = 2*Math.acos(Math.min(1,dot))*180/Math.PI;
            if (step > maxStep) {
              maxStep = step; maxAt = {name,clock:frame.clock};
              const endpoints = {LeftArm:['LeftArm','LeftForeArm'], RightArm:['RightArm','RightForeArm'], LeftForeArm:['LeftForeArm','LeftHand'], RightForeArm:['RightForeArm','RightHand']}[name];
              if (endpoints) {
                const dir = f => f[endpoints[1]].map((v,j)=>v-f[endpoints[0]][j]);
                const a=dir(frame),b=dir(previous);
                maxAt.directionAngle = Math.acos(Math.max(-1,Math.min(1,a.reduce((s,v,j)=>s+v*b[j],0)/Math.hypot(...a)/Math.hypot(...b))))*180/Math.PI;
              }
            }
          }
          previous = frame;
        }); return { done: window.actionDone, result: window.actionResult, maxStep, maxAt, probe: avatarLab.inspect() }`);
      assert.equal(result.done, true, `${action} stalled`);
      assert.equal(result.result, true, `${action} failed`);
      assert.ok(Number.isFinite(result.probe.Head[1]), `${action} broke the rig`);
      actionQuality[action] = +result.maxStep.toFixed(2);
      assert.ok(result.maxStep < 15, `${action} has an abrupt joint rotation: ${result.maxStep}`);
      console.log('ACTION', action, JSON.stringify({maxStep:result.maxStep,maxAt:result.maxAt}));
    }
    await run('avatarLab.stop(); avatarLab.setProp("bottle"); avatarLab.pose("idle"); avatarLab.x = 16; window.walk = avatarLab.walkTo(350, { speed: 130 }); await avatarLab.advance(1000)');
    await shot('walk');
    console.log('WALK', JSON.stringify(await run('return avatarLab.inspect()')));
    await run('await avatarLab.advance(10000); await window.walk');
    assert.equal(await run('return avatarLab.x'), 350);
    assert.equal(await run('return avatarLab.facing'), 0);
    const hit = await run('const p = avatarLab.anchor("chest"); const r = document.getElementById("floor").getBoundingClientRect(); return avatarLab.hitTest(r.left + p.x, r.top + p.y)');
    assert.equal(hit, true, 'chest is not interactive');
    // Sample distance-driven gait and every frame of drinking, rather than only end poses.
    const motion = await run(`avatarLab.y = 10; avatarLab.x = 0; avatarLab.setFacing(1); avatarLab.pose('idle');
      await avatarLab.advance(1000); avatarLab.walkTo(650, {speed:200}); await avatarLab.advance(1000);
      const walkFrames = []; for (let i=0; i<120; i++) { await avatarLab.advance(1000/60); walkFrames.push(avatarLab.inspect()); }
      avatarLab.stop(); avatarLab.setFacing(0); avatarLab.setProp('bottle'); avatarLab.pose('present'); await avatarLab.advance(1500);
      avatarLab.play('drink'); const drinkFrames = [];
      for (let i=0; i<270; i++) { await avatarLab.advance(1000/60); drinkFrames.push(avatarLab.inspect()); }
      return {walkFrames,drinkFrames};`);
    let footSlide = 0, minToeY = Infinity, maxJointStep = 0, minSpoutDistance = Infinity;
    for (let i = 1; i < motion.walkFrames.length; i++) {
      const p = motion.walkFrames[i-1], n = motion.walkFrames[i];
      for (const [side, offset] of [['L',0],['R',0.5]]) {
        const phase = (n.phase+offset)%1, prevPhase=(p.phase+offset)%1;
        if (n.gait > 0.98 && phase > 0.14 && phase < 0.34 && prevPhase > 0.14 && prevPhase < 0.34)
          footSlide = Math.max(footSlide, Math.abs(n.footScreenX[side]-p.footScreenX[side]));
      }
      minToeY = Math.min(minToeY,n.LeftToeBase[1],n.RightToeBase[1]);
    }
    for (let i = 1; i < motion.drinkFrames.length; i++) {
      const p = motion.drinkFrames[i-1], n = motion.drinkFrames[i];
      minSpoutDistance = Math.min(minSpoutDistance,n.spoutToMouth);
      for (const name of Object.keys(n.rotations)) {
        const dot = Math.abs(n.rotations[name].reduce((sum,v,j)=>sum+v*p.rotations[name][j],0));
        maxJointStep = Math.max(maxJointStep,2*Math.acos(Math.min(1,dot))*180/Math.PI);
      }
    }
    const quality = {footSlidePxPerFrame:footSlide,minToeYMetres:minToeY,maxDrinkJointStepDegrees:maxJointStep,minSpoutDistanceMetres:minSpoutDistance};
    console.log('MOTION', JSON.stringify(quality));
    assert.ok(footSlide < 0.8, 'stance foot slides');
    assert.ok(minToeY > -0.01, 'toe penetrates the floor');
    assert.ok(maxJointStep < 15, 'drink motion pops between frames');
    assert.ok(minSpoutDistance < 0.035, 'bottle misses the mouth');
    await run('avatarLab.x = 350');
    for (const id of ['nova', 'me3d']) {
      await run('window.cancelledDone = false; avatarLab.play("stretch").then(() => window.cancelledDone = true)');
      await run(`avatarLab.setAvatar(${JSON.stringify(id)}); avatarLab.timeScale = 0`);
      if (id === 'me3d') {
        for (let i = 0; i < 100 && !await run('return avatarLab.ready'); i++) await pause(100);
        assert.equal(await run('return avatarLab.ready'), true);
      }
      assert.equal(await run('return avatarLab.avatarId'), id);
      assert.equal(await run('return avatarLab.x'), 350);
      assert.equal(await run('return window.cancelledDone'), true, 'switch left an action waiting forever');
      console.log('SWITCH', id, 'PASS');
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    await run('document.querySelector(".nb-avatar-3d canvas").dispatchEvent(new Event("webglcontextlost", { cancelable: true }))');
    assert.equal(await run('return avatarLab.avatarId'), 'nova', 'WebGL failure did not recover');
    await run('avatarLab.destroy()');
    assert.equal(await run('return document.querySelectorAll(".nb-avatar").length'), 0);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ present, actions, actionQuality, props, quality, errors, result: 'PASS' }, null, 2));
    console.log('AVATAR VERIFICATION PASS');
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    app.exit(1);
  }
});
