'use strict';

// Accept self-contained, uncompressed Avaturn-style GLB rigs only.
const REQUIRED = ['Hips', 'Spine', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
function validateModel(buffer) {
  if (buffer.length < 20 || buffer.length > 25 * 1024 * 1024) throw new Error('Choose a GLB model under 25 MB.');
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('This is not a valid GLB 2.0 file.');
  const length = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a || length > buffer.length - 20) throw new Error('The GLB metadata is invalid.');
  let doc;
  try { doc = JSON.parse(buffer.subarray(20, 20 + length).toString('utf8')); } catch { throw new Error('The GLB metadata is unreadable.'); }
  if ([...(doc.buffers || []), ...(doc.images || [])].some(v => v.uri)) throw new Error('Export a self-contained GLB with embedded textures.');
  if (doc.extensionsRequired?.length) throw new Error('Export without compression or required extensions.');
  const joints = new Set((doc.skins || []).flatMap(s => s.joints || []));
  const names = new Set([...joints].map(i => doc.nodes?.[i]?.name));
  if (!REQUIRED.every(n => names.has(n))) throw new Error('This model needs an Avaturn T-pose humanoid rig with standard bone names.');
  return doc;
}
module.exports = { validateModel };
