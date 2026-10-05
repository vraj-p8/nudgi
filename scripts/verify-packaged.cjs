// Smoke-test the actual packaged executable, using an isolated profile and a loopback-only debugger.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { sanitizeConfig } = require('../src/main/store');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/packaged-release');
const profile = path.join(out, `profile-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(sanitizeConfig({ settings: {userName:'friend',hotkey:'',launchAtLogin:false,sound:false}, runtime:{onboarded:true} })));
const child = spawn(path.join(root, 'dist/win-unpacked/Nudgi.exe'), ['--remote-debugging-port=0'], { windowsHide:true, env:{...process.env,NUDGE_USER_DATA:profile}, stdio:'ignore' });
const pause = ms => new Promise(r => setTimeout(r,ms));
let socket;
(async () => {
  try {
    const portFile = path.join(profile,'DevToolsActivePort');
    for(let i=0;i<100&&!fs.existsSync(portFile);i++) await pause(100);
    const port = Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    let target;
    for(let i=0;i<100;i++) {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = tabs.find(t=>t.url.includes('/settings/')); if(target) break; await pause(100);
    }
    assert.ok(target,'Packaged settings opens on normal launch');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    for(let i=0;i<100&&!await run('!!document.querySelector("#rem-cards .card")');i++)await pause(100);
    const state=await run('nudge.getState()');
    assert.equal(state.settings.avatarId,'nova');assert.equal(state.meta.avatarModelUrl,null);assert.equal(state.meta.isPackaged,true);
    await run('document.querySelector("[data-section=buddy]").click()');await pause(500);
    assert.deepEqual(await run('[...document.querySelectorAll(".buddy-card")].map(c=>c.dataset.id)'),['nova']);
    await run('document.querySelector("#avatar-guide-toggle").click()');await pause(300);
    fs.writeFileSync(path.join(out,'settings.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({result:'PASS',version:state.meta.version,defaultAvatar:state.settings.avatarId,personalModelIncluded:false},null,2));
    console.log('PACKAGED APP PASS: opens settings, Kai-only fresh profile, guide renders');
  } finally {
    socket?.close();
    if(child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
