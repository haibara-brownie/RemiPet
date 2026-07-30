'use strict';

// 生成托盘图标:透明窗口渲染 0 号姿势,截图后裁头部区域缩到 32px,
// 存 assets/tray.png(Windows/Linux 托盘用;mac 用 🦇 文字标)。
// 用法: npx electron scripts/gen-tray.js

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 220, height: 280, show: true, frame: false, transparent: true, hasShadow: false,
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'));
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('window.__ready')) break;
    await sleep(100);
  }
  await win.webContents.executeJavaScript("window.__seek('0', 0)");
  await sleep(300);
  const img = await win.webContents.capturePage();
  const { width, height } = img.getSize();
  // 脸部大致占画面横向 28%~72%、纵向 34%~70%(顶部是气泡留白)
  const crop = img.crop({
    x: Math.round(width * 0.28),
    y: Math.round(height * 0.42),
    width: Math.round(width * 0.44),
    height: Math.round(height * 0.34),
  });
  const icon = crop.resize({ width: 32, height: 32 });
  const out = path.join(__dirname, '..', 'assets', 'tray.png');
  fs.writeFileSync(out, icon.toPNG());
  console.log('wrote', out, icon.getSize());
  app.quit();
});
