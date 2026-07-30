'use strict';

// RemiPet 主进程:透明置顶小窗 + 托盘 + 本地状态 server + 权限卡片 + 用量统计。

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Core } = require('./backend/core');
const { startServer } = require('./backend/server');
const { createPermissions } = require('./backend/permission');
const { Metering } = require('./backend/metering');
const { focusTerminal } = require('./backend/focus');
const T = require('./backend/transport');
const S = require('./shared/states');
const installer = require('./hook/install');

const CONFIG_PATH = path.join(os.homedir(), '.remi-pet', 'config.json');
const BASE_W = 260;
const BASE_H = 340;
const SIZE_PRESETS = [['小', 0.5], ['中', 0.65], ['大', 0.85], ['特大', 1.0]];
const DEFAULT_SCALE = 0.65;

let win = null;
let tray = null;
let core = null;
let permissions = null;
let metering = null;
let serverPort = null;
let rendererReady = false;
let demoActive = false;

function winSize() {
  const cfg = loadConfig();
  const scale = typeof cfg.scale === 'number' ? cfg.scale : DEFAULT_SCALE;
  return { w: Math.round(BASE_W * scale), h: Math.round(BASE_H * scale), scale };
}

// 完整演示:依次展示所有状态和气泡(带序号标签),期间屏蔽真实事件
const DEMO_STEPS = [
  { state: 'idle', animation: 'a', bubble: '【1/13 打招呼】哦?你来了', ms: 6000 },
  { state: 'thinking', animation: 'e', bubble: '【2/13 思考】唔姆…怎么写比较好', ms: 6000 },
  { state: 'working', animation: 'b', bubble: '【3/13 翻文件】唔姆…在翻文件', ms: 5000 },
  { state: 'working', animation: 'd', bubble: '【4/13 敲命令】唰唰唰…在敲命令', ms: 5000 },
  { state: 'waiting', animation: 'a', bubble: '【5/13 一键批准】蕾米想用 Bash,点下面按钮!', tone: 'warn', permission: { id: 'demo', toolName: 'Bash', count: 1 }, ms: 8000 },
  { state: 'waiting', animation: 'a', bubble: '【6/13 等回话】蕾米在等你回话哦~', canFocus: true, ms: 6000 },
  { state: 'thinking', animation: 'c', bubble: '【7/13 被夸奖】嘿嘿…被夸了☆', ms: 5000 },
  { state: 'compacting', animation: 'b', bubble: '【8/13 压缩上下文】整理一下记忆…', ms: 5000 },
  { state: 'working', animation: 'b', bubble: '【9/13 上下文预警】唔姆…在翻文件\n(上下文已用 82%)', tone: 'warn', ms: 6000 },
  { state: 'working', animation: 'e', bubble: '【10/13 召唤小弟】召唤了小弟干活!', ms: 5000 },
  { state: 'done', animation: 'c', bubble: '【11/13 完工+摘要】写完了!快来验收~\n「已修复登录页的报错,测试全绿」', ms: 8000 },
  { state: 'error', animation: 'd', bubble: '【12/13 出错】呜哇,出错了…(限流了)', tone: 'error', ms: 6000 },
  { state: 'sleeping', animation: '0', bubble: '【13/13 睡觉】(平时无气泡)', ms: 5000 },
];

async function runDemo() {
  if (demoActive) return;
  demoActive = true;
  for (const step of DEMO_STEPS) {
    if (!win || win.isDestroyed()) break;
    pushUpdate({ tone: 'info', ...step });
    await new Promise((r) => setTimeout(r, step.ms));
  }
  demoActive = false;
  pushRealState();
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; }
}

function saveConfig(patch) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2));
  } catch {}
}

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const { w, h } = winSize();
  return { x: workArea.x + workArea.width - w - 24, y: workArea.y + workArea.height - h - 8 };
}

function pushUpdate(u) {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send('remi:update', u);
}

// 真实状态 = core 全局态 + 悬着的权限卡片(卡片优先展示)
function buildRealState() {
  const g = core.global();
  const card = permissions.first();
  if (card) {
    return {
      ...g,
      state: 'waiting',
      animation: 'a',
      bubble: `蕾米想用 ${card.toolName}${card.count > 1 ? `(还有 ${card.count - 1} 个在排队)` : ''},批不批?`
        + (card.cwd ? `\n[${path.basename(card.cwd)}]` : ''),
      tone: 'warn',
      permission: { id: card.id, toolName: card.toolName, count: card.count },
      canFocus: !!g.terminal,
    };
  }
  return { ...g, canFocus: !!g.terminal && (g.state === 'waiting' || g.state === 'done'), permission: null };
}

function pushRealState() {
  if (!demoActive) pushUpdate(buildRealState());
}

function hookStatusLabel() {
  try { return installer.status(true).length ? '✓ Hook 已装' : 'Hook 未装'; } catch { return 'Hook 状态未知'; }
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function buildTray() {
  if (!tray) {
    // mac 菜单栏用 🦇 文字标最清爽;其他平台用蕾米头像图标
    if (process.platform === 'darwin') {
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle('🦇');
    } else {
      const iconPath = path.join(__dirname, 'assets', 'tray.png');
      const icon = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
        : nativeImage.createEmpty();
      tray = new Tray(icon);
    }
    tray.setToolTip('RemiPet — Claude Code 桌宠');
  }
  const usage = metering ? metering.today() : { tokens: 0, cost: 0 };
  const g = core ? core.global() : {};
  const ctxLine = g.contextPercent != null ? ` · 上下文 ${g.contextPercent}%` : '';

  const sizeItems = SIZE_PRESETS.map(([label, scale]) => ({
    label,
    type: 'radio',
    checked: Math.abs(winSize().scale - scale) < 0.01,
    click: () => {
      saveConfig({ scale });
      if (win) {
        const [x, y] = win.getPosition();
        const [, oldH] = win.getSize();
        const { w, h } = winSize();
        win.setBounds({ x, y: y + oldH - h, width: w, height: h });
      }
      buildTray();
    },
  }));
  const testItems = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'sleeping'].map((state) => ({
    label: state,
    click: () => pushUpdate({
      state,
      animation: S.pick(S.STATE_ANIM[state]),
      bubble: S.pick(S.STATE_BUBBLE[state]) || (state === 'working' ? S.toolBubble('Bash') : null),
      tone: state === 'error' ? 'error' : 'info',
    }),
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `端口 ${serverPort ?? '未启动'} · ${hookStatusLabel()}${ctxLine}`, enabled: false },
    { label: `今日: ${fmtTokens(usage.tokens)} tokens / $${usage.cost.toFixed(2)}`, enabled: false },
    { type: 'separator' },
    { label: '显示 / 隐藏', click: () => { if (win) (win.isVisible() ? win.hide() : win.show()); } },
    { label: '尺寸', submenu: sizeItems },
    { label: '回到默认位置', click: () => { if (win) { const p = defaultPosition(); win.setPosition(p.x, p.y); saveConfig(p); } } },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); buildTray(); },
    },
    { label: '安装 Claude Hook', click: () => { runInstaller('install'); buildTray(); } },
    { label: '卸载 Claude Hook', click: () => { runInstaller('uninstall'); buildTray(); } },
    { type: 'separator' },
    { label: '完整演示(过一遍所有状态)', click: () => runDemo() },
    { label: '测试状态', submenu: testItems },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function runInstaller(cmd) {
  try {
    if (cmd === 'install') installer.install();
    else installer.uninstall();
  } catch (err) {
    dialog.showErrorBox('RemiPet', `Hook ${cmd} 失败:\n${err.message}`);
  }
}

function createWindow() {
  const cfg = loadConfig();
  const { w, h } = winSize();
  const pos = Number.isInteger(cfg.x) && Number.isInteger(cfg.y) ? { x: cfg.x, y: cfg.y } : defaultPosition();
  win = new BrowserWindow({
    width: w, height: h, x: pos.x, y: pos.y,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));

  let saveTimer = null;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      saveConfig({ x, y });
    }, 500);
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  core = new Core();
  core.on('update', pushRealState);
  core.on('session-end', (sid) => permissions.sweepSession(sid));

  permissions = createPermissions({ onChange: () => { pushRealState(); } });

  metering = new Metering();
  metering.start();
  // 托盘用量行每分钟跟着刷新
  const trayTimer = setInterval(() => buildTray(), 60 * 1000);
  trayTimer.unref?.();

  const opts = { onDemo: () => runDemo(), permissions };
  if (process.env.REMI_DEBUG_SNAP === '1') {
    opts.onSnap = async () => (await win.webContents.capturePage()).toPNG();
  }
  startServer(core, (err, info) => {
    if (err) dialog.showErrorBox('RemiPet', `本地服务启动失败:${err.message}`);
    else serverPort = info.port;
    buildTray();
  }, opts);

  // hook 路径自愈:已装过 hook 但命令指向的不是当前这份代码(比如从仓库
  // 直接跑切换到 .app,或 .app 被移动过)时原地纠正。install() 幂等,
  // 路径一致就什么都不写。
  try {
    if (installer.status(true).length) installer.install();
  } catch (err) {
    console.error('hook 路径自愈失败:', err.message);
  }

  ipcMain.on('remi:ready', () => {
    rendererReady = true;
    pushRealState();
  });
  ipcMain.on('remi:decide', (_e, { id, behavior }) => {
    permissions.decide(id, behavior === 'allow' ? 'allow' : 'deny');
  });
  ipcMain.on('remi:focus', () => {
    const g = core.global();
    if (g.terminal) focusTerminal(g.terminal, () => {});
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  T.clearRuntimePort();
  permissions?.cleanup();
  metering?.stop();
  core?.dispose();
});
