'use strict';

// 拆帧分析:把每个动画按时间轴均匀定格 8 帧,拼成带序号的动作条,
// 存到 /tmp/remi_frames/<anim>.png。用法: npx electron scripts/frames-main.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ANIMS = ['0', 'a', 'a_win', 'b', 'c', 'd', 'd_win', 'e', 'light'];
const N = 8;
const OUT = '/tmp/remi_frames';
const CELL_W = 240;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: CELL_W, height: 300, show: true, frame: false });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'), { query: { debug: '1' } });
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('window.__ready')) break;
    await sleep(100);
  }

  for (const anim of ANIMS) {
    const dur = await win.webContents.executeJavaScript(
      `window.__player.skeleton.data.findAnimation(${JSON.stringify(anim)}).duration`);
    const n = dur > 0 ? N : 1;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = dur * i / N;
      await win.webContents.executeJavaScript(`window.__seek(${JSON.stringify(anim)}, ${t})`);
      await sleep(120);
      frames.push({ t, data: (await win.webContents.capturePage()).toDataURL() });
    }
    const cells = frames.map((f, i) =>
      `<div class="cell"><img src="${f.data}"><span>#${i} t=${f.t.toFixed(2)}s</span></div>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#2a2a35;font-family:monospace}
      h1{color:#fff;margin:4px 8px;font-size:16px}
      .grid{display:grid;grid-template-columns:repeat(4,${CELL_W}px);gap:4px;padding:4px}
      .cell{position:relative}.cell img{width:${CELL_W}px;display:block}
      .cell span{position:absolute;left:4px;top:4px;color:#ffd54a;font-size:14px;background:rgba(0,0,0,.55);padding:1px 4px}
    </style><h1>动画: ${anim}(时长 ${dur.toFixed(2)}s,共 ${n} 帧)</h1><div class="grid">${cells}</div>`;
    const sheetPath = path.join(OUT, `.sheet-${anim}.html`);
    fs.writeFileSync(sheetPath, html);
    const rows = Math.ceil(n / 4);
    const sw = new BrowserWindow({ width: 4 * CELL_W + 28, height: rows * 304 + 44, show: true, frame: false });
    await sw.loadFile(sheetPath);
    await sleep(400);
    fs.writeFileSync(path.join(OUT, `${anim}.png`), (await sw.capturePage()).toPNG());
    sw.close();
    console.log('sheet:', anim);
  }
  app.quit();
});
