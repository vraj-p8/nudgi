import { createAvatar, AVATARS, PROPS } from '../shared/avatar-engine.js';
import { POSE_NAMES_3D, ACTIONS_3D } from '../shared/avatar-3d.js';

const $ = (id) => document.getElementById(id);
const floor = $('floor');
const av = createAvatar(floor, { height: 360, avatarId: 'me3d', prop: 'bottle' });
window.avatarLab = av;
const options = (id, items) => {
  for (const item of items) {
    const option = document.createElement('option');
    option.value = typeof item === 'string' ? item : item.id;
    option.textContent = typeof item === 'string' ? item : item.name;
    $(id).append(option);
  }
};
options('pose', POSE_NAMES_3D); options('action', ACTIONS_3D); options('prop', PROPS); options('avatar', AVATARS.filter((a) => a.id !== 'custom'));
$('prop').value = 'bottle';
const center = () => { av.x = Math.max(0, (floor.clientWidth - av.width) / 2); };
new ResizeObserver(center).observe(floor);
center();
av.on('ready', () => { $('status').textContent = 'Ready — your 3D avatar'; });
av.on('error', () => { $('status').textContent = '3D unavailable — using Kai'; });
$('pose').onchange = () => { av.stop(); av.pose($('pose').value); };
$('prop').onchange = () => av.setProp($('prop').value, '💧');
$('avatar').onchange = () => { av.setAvatar($('avatar').value); center(); $('status').textContent = $('avatar').value === 'me3d' ? 'Loading your avatar…' : 'Ready — Kai'; };
$('play').onclick = async () => { $('status').textContent = `Playing ${$('action').value}…`; await av.play($('action').value); $('status').textContent = 'Ready'; };
$('stop').onclick = () => av.stop();
$('left').onclick = () => av.walkTo(16);
$('right').onclick = () => av.walkTo(floor.clientWidth - av.width - 16);
$('front').onclick = () => av.setFacing(0);
$('background').onclick = () => $('stage').classList.toggle('light');
let debug = false;
$('debug').onclick = () => av.debug(debug = !debug);
$('freeze').onclick = () => { av.timeScale = av.timeScale ? 0 : 1; $('freeze').textContent = av.timeScale ? 'Freeze' : 'Resume'; };
document.addEventListener('pointermove', (e) => av.lookAt(e.clientX, e.clientY));
document.addEventListener('pointerleave', () => av.lookAt(null));
setInterval(() => {
  const p = av.inspect?.();
  $('probe').textContent = p ? `Yaw: ${p.yaw}°\nBottle spout → mouth: ${p.spoutToMouth} m` : '';
}, 500);
window.addEventListener('pagehide', () => av.destroy());
