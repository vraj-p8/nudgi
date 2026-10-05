// Rasterise the canonical SVG with Chromium; ICO frames each render at their native size.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
app.setPath('userData', path.join(root, 'output/icons/user-data'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { backgroundThrottling: false } });
  const source = fs.readFileSync(path.join(assets, 'nudgi-mark.svg'), 'utf8');
  const render = async (size, tray = false, paused = false) => {
    let inner = source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'));
    if (paused) inner = inner.replaceAll('#5574FF', '#8992AC');
    else if (!tray) inner = inner.replaceAll('#5574FF', '#FFFFFF');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${tray ? '' : '<rect x="8" y="8" width="496" height="496" rx="116" fill="#5574FF"/>'}<g transform="${tray ? 'translate(-24 -8) scale(1.04)' : 'translate(32 20) scale(.86)'}">${inner}</g></svg>`;
    const html = `<html style="background:transparent"><body style="margin:0;background:transparent">${svg}</body></html>`;
    win.setContentSize(size, size);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(r => setTimeout(r, 80));
    return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).toPNG();
  };
  try {
    fs.writeFileSync(path.join(assets, 'icon.png'), await render(512));
    const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
    const frames = [];
    for (const size of sizes) frames.push(await render(size));
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    for (let i = 0; i < sizes.length; i++) {
      const at = 6 + i * 16;
      header[at] = header[at + 1] = sizes[i] === 256 ? 0 : sizes[i];
      header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
      header.writeUInt32LE(frames[i].length, at + 8); header.writeUInt32LE(offset, at + 12);
      offset += frames[i].length;
    }
    fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...frames]));
    for (const paused of [false, true]) for (const size of [16, 32]) {
      const name = `tray${paused ? '-paused' : ''}${size === 32 ? '@2x' : ''}.png`;
      fs.writeFileSync(path.join(assets, name), await render(size, true, paused));
    }
    console.log('Nudgi app, ICO and tray icons generated from assets/nudgi-mark.svg');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
