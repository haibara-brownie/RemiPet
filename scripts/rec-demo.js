'use strict';

// 录制演示 GIF:按脚本驱动桌宠状态,逐帧 capturePage,交给 ffmpeg 合成。
// 用法: npx electron scripts/rec-demo.js [clips|scenes]
// 产物: /tmp/remi-demo/*.gif
//
// clips  = 每个动画一个小 GIF(无气泡,录完整循环周期 → 循环播放无缝),README 状态表格用
// scenes = 带气泡/按钮的功能演示,README 顶部用

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = '/tmp/remi-demo';
const BG = '#f7f3ee';               // GIF 用浅色底比透明底清晰
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 状态小图:按动画录完整一个周期 ——
const CLIP_FPS = 8;
const CLIP_W = 130;
const CLIP_H = 170;
const CLIPS = ['0', 'a', 'a_win', 'b', 'c', 'd', 'd_win', 'e'];

// —— 功能演示:带气泡和按钮 ——
const SCENE_FPS = 10;
const SCENE_SCALE = 0.72;
const SCENES = {
  workflow: [
    { anim: 'e', bubble: '唔姆…怎么写比较好', sec: 2.0 },
    { anim: 'b', bubble: '唔姆…在翻文件', sec: 1.8 },
    { anim: 'd', bubble: '唰唰唰…在敲命令', sec: 2.0 },
    { anim: 'c', bubble: '哼哼,完工了哦☆\n「已修复登录页的报错,测试全绿」', sec: 2.8 },
  ],
  permission: [
    { anim: 'd', bubble: '唰唰唰…在敲命令', sec: 1.6 },
    { anim: 'a', bubble: '蕾米想用 Bash,批不批?', tone: 'warn',
      actions: { permission: { id: 'demo' }, canFocus: false }, sec: 3.4 },
    { anim: 'd', bubble: '唰唰唰…在敲命令', sec: 1.8 },
  ],
  waiting: [
    { anim: 'a', bubble: '蕾米在等你回话哦~\n(上下文已用 82%)', tone: 'warn',
      actions: { permission: null, canFocus: true }, sec: 3.2 },
  ],
  emotion: [
    { anim: 'c', bubble: '嘿嘿…被夸了☆', sec: 2.4 },
    { anim: 'd', bubble: '呜哇,出错了…(限流了)', tone: 'error', sec: 2.4 },
  ],
};

// capturePage 有一帧合成滞后:等一会儿并丢弃 2 帧,否则首帧是上一步的残留画面
async function settle(win) {
  await sleep(220);
  for (let i = 0; i < 2; i++) await win.webContents.capturePage();
}

function toGif(dir, gifPath, fps) {
  const pal = path.join(dir, 'palette.png');
  // 两遍法生成调色板,GIF 质量/体积都明显更好
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps),
    '-i', path.join(dir, '%04d.png'), '-vf', 'palettegen=stats_mode=diff', pal]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps),
    '-i', path.join(dir, '%04d.png'), '-i', pal,
    '-lavfi', 'paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', gifPath]);
  return Math.round(fs.statSync(gifPath).size / 1024);
}

async function shoot(win, dir, count, fps, n0 = 0) {
  let n = n0;
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${String(n++).padStart(4, '0')}.png`), img.toPNG());
    const wait = 1000 / fps - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  return n;
}

async function recordClips(win) {
  await win.webContents.executeJavaScript("document.body.classList.add('icon-mode')");
  win.setSize(CLIP_W, CLIP_H);
  await sleep(400);
  for (const anim of CLIPS) {
    const dur = await win.webContents.executeJavaScript(
      `window.__player.skeleton.data.findAnimation(${JSON.stringify(anim)}).duration`);
    // 录满一个周期,GIF 循环起来才无缝(静止动画只需 1 帧)
    const frames = dur > 0 ? Math.max(2, Math.round(dur * CLIP_FPS)) : 1;
    const dir = path.join(OUT, `clip-${anim}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await win.webContents.executeJavaScript(`window.__setAnim(${JSON.stringify(anim)})`);
    await settle(win);
    await shoot(win, dir, frames, CLIP_FPS);
    const kb = toGif(dir, path.join(OUT, `anim-${anim}.gif`), CLIP_FPS);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`✅ anim-${anim}.gif  ${frames} 帧  ${kb} KB`);
  }
  await win.webContents.executeJavaScript("document.body.classList.remove('icon-mode')");
}

async function recordScenes(win) {
  win.setSize(Math.round(260 * SCENE_SCALE), Math.round(340 * SCENE_SCALE));
  await sleep(400);
  for (const [name, steps] of Object.entries(SCENES)) {
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const step of steps) {
      await win.webContents.executeJavaScript(`
        window.__setAnim(${JSON.stringify(step.anim)});
        window.__setBubble(${JSON.stringify(step.bubble || null)}, ${JSON.stringify(step.tone || 'info')});
        window.__setActions(${JSON.stringify((step.actions && step.actions.permission) || null)},
                            ${JSON.stringify(!!(step.actions && step.actions.canFocus))});
      `);
      await settle(win);
      n = await shoot(win, dir, Math.round(step.sec * SCENE_FPS), SCENE_FPS, n);
    }
    const kb = toGif(dir, path.join(OUT, `${name}.gif`), SCENE_FPS);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`✅ ${name}.gif  ${n} 帧  ${kb} KB`);
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mode = process.argv.find((a) => a === 'clips' || a === 'scenes');
  const win = new BrowserWindow({
    width: 200, height: 260, show: true, frame: false, transparent: false,
    backgroundColor: BG, hasShadow: false, resizable: true,
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'));
  for (let i = 0; i < 120; i++) {
    if (await win.webContents.executeJavaScript('window.__ready')) break;
    await sleep(100);
  }
  await win.webContents.executeJavaScript(`document.body.style.background = ${JSON.stringify(BG)}`);
  await sleep(600);

  if (!mode || mode === 'clips') await recordClips(win);
  if (!mode || mode === 'scenes') await recordScenes(win);
  console.log(`\n产物目录:${OUT}`);
  app.quit();
});
