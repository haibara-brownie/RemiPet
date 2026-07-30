'use strict';

// 调试用:启动一个窗口,把每个 Spine 动画截两帧图存到 /tmp/remi_shots/。
// 用法: npx electron scripts/snap-main.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ANIMS = ['0', 'a', 'a_win', 'b', 'c', 'd', 'd_win', 'e', 'light'];
const OUT = '/tmp/remi_shots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 340, height: 400, show: true, frame: false,
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'), { query: { debug: '1' } });

  for (let i = 0; i < 100; i++) {
    const ready = await win.webContents.executeJavaScript('window.__ready');
    if (ready) break;
    await sleep(100);
  }

  for (const anim of ANIMS) {
    await win.webContents.executeJavaScript(`window.__setAnim(${JSON.stringify(anim)}, true)`);
    await sleep(500);
    let img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${anim}_f1.png`), img.toPNG());
    await sleep(900);
    img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${anim}_f2.png`), img.toPNG());
    console.log('captured', anim);
  }
  app.quit();
});
