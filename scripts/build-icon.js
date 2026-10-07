'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  const buildDirectory = path.join(__dirname, '..', 'build');
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    backgroundColor: '#2563eb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  await window.loadFile(path.join(buildDirectory, 'icon.html'));
  await new Promise((resolve) => setTimeout(resolve, 350));
  const image = await window.webContents.capturePage();
  window.destroy();
  if (image.isEmpty()) throw new Error('Electron could not render build/icon.svg');

  const sizes = [16, 32, 48, 256];
  const pngImages = sizes.map((size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(buildDirectory, 'icon.png'), image.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(buildDirectory, 'icon.ico'), createIco(pngImages, sizes));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

function createIco(images, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach((png, index) => {
    const entryOffset = index * 16;
    entries.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], entryOffset);
    entries.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], entryOffset + 1);
    entries.writeUInt8(0, entryOffset + 2);
    entries.writeUInt8(0, entryOffset + 3);
    entries.writeUInt16LE(1, entryOffset + 4);
    entries.writeUInt16LE(32, entryOffset + 6);
    entries.writeUInt32LE(png.length, entryOffset + 8);
    entries.writeUInt32LE(offset, entryOffset + 12);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...images]);
}
