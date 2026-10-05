'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateModel } = require('../src/main/avatar-model');
function glb(doc) {
  const text = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(padded);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}
test('model import rejects truncated files and invalid lengths', () => {
  assert.throws(() => validateModel(Buffer.alloc(3)));
  const data = glb({}); data.writeUInt32LE(999999, 12);
  assert.throws(() => validateModel(data), /metadata/);
});
test('model import rejects external textures and unsupported rigs', () => {
  assert.throws(() => validateModel(glb({ images: [{ uri: 'https://example.com/image.png' }] })), /embedded/);
  assert.throws(() => validateModel(glb({ nodes: [{ name: 'Hips' }] })), /rig/);
  assert.throws(() => validateModel(glb({ extensionsRequired: ['KHR_draco_mesh_compression'] })), /compression/);
});
