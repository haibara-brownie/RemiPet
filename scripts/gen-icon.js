'use strict';

// 生成 .app 图标:渲染蕾米(0 号姿势)整体截图 → 方形留白 → 多尺寸 iconset → icns。
// 用法: npx electron scripts/gen-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const assets = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const win = new BrowserWindow({
    width: 512, height: 512, show: true, frame: false, transparent: true, hasShadow: false,
  });
  // 只要人物,不要气泡:直接渲染一个铺满的 spine 画布
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'), { query: { icon: '1' } });
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('window.__ready')) break;
    await sleep(100);
  }
  await win.webContents.executeJavaScript("window.__seek('0', 0)");
  await sleep(400);
  const shot = await win.webContents.capturePage();
  const basePng = path.join(assets, 'icon.png');
  fs.writeFileSync(basePng, shot.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('base png:', basePng, shot.getSize());

  // iconset → icns(mac 自带 sips/iconutil)
  const iconset = path.join(os.tmpdir(), 'remi.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  for (const s of SIZES) {
    for (const [name, px] of [[`icon_${s}x${s}.png`, s], [`icon_${s}x${s}@2x.png`, s * 2]]) {
      if (px > 1024) continue;
      execFileSync('sips', ['-z', String(px), String(px), basePng, '--out', path.join(iconset, name)],
        { stdio: 'ignore' });
    }
  }
  const icns = path.join(assets, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  console.log('icns:', icns, fs.statSync(icns).size, 'bytes');
  app.quit();
});
