'use strict';

// RemiPet 主进程:透明置顶小窗 + 托盘 + 本地状态 server + 权限卡片 + 用量统计。
// 支持两只宠:Claude(hook 驱动)与 Codex(只读 tail rollout 驱动),托盘勾选各自开关。

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Core } = require('./backend/core');
const { startServer } = require('./backend/server');
const { createPermissions } = require('./backend/permission');
const { Metering } = require('./backend/metering');
const { CodexWatcher } = require('./backend/codex-watch');
const { focusTerminal } = require('./backend/focus');
const T = require('./backend/transport');
const S = require('./shared/states');
const installer = require('./hook/install');

const CONFIG_PATH = path.join(os.homedir(), '.remi-pet', 'config.json');
const BASE_W = 260;
const BASE_H = 340;
const SIZE_PRESETS = [['小', 0.5], ['中', 0.65], ['大', 0.85], ['特大', 1.0]];
const DEFAULT_SCALE = 0.65;
const AGENTS = ['claude', 'codex'];

// 每只宠一份运行时:core 常驻(便于 server/watcher 绑定),win 随勾选生灭
// extra = 为容纳气泡/按钮在基础高度上追加的窗口高度(向上生长,人物不缩水)
const runtime = {
  claude: { core: null, win: null, ready: false, extra: 0 },
  codex: { core: null, win: null, ready: false, extra: 0 },
};
let tray = null;
let permissions = null;
let metering = null;
let codexWatcher = null;
let serverPort = null;
let demoAgent = null; // 演示进行中的宠(演示期间屏蔽它的真实事件)

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; }
}

function saveConfig(patch) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2));
  } catch {}
}

function agentsCfg() {
  const a = loadConfig().agents || {};
  return { claude: a.claude !== false, codex: a.codex !== false }; // 默认双开
}

function winSize() {
  const cfg = loadConfig();
  const scale = typeof cfg.scale === 'number' ? cfg.scale : DEFAULT_SCALE;
  return { w: Math.round(BASE_W * scale), h: Math.round(BASE_H * scale), scale };
}

function defaultPosition(agent) {
  const { workArea } = screen.getPrimaryDisplay();
  const { w, h } = winSize();
  // Claude 在右下角,Codex 排它左边
  const x = workArea.x + workArea.width - w - 24 - (agent === 'codex' ? w + 12 : 0);
  return { x, y: workArea.y + workArea.height - h - 8 };
}

function savedPosition(agent) {
  const cfg = loadConfig();
  const p = (cfg.pets && cfg.pets[agent]) || (agent === 'claude' ? cfg : {}); // 旧配置顶层 x/y 归 claude
  return Number.isInteger(p.x) && Number.isInteger(p.y) ? { x: p.x, y: p.y } : null;
}

function savePetPos(agent, x, y) {
  saveConfig({ pets: { ...(loadConfig().pets || {}), [agent]: { x, y } } });
}

// 渲染层报来内容高度 → 调整窗口:底边固定,向上生长/回缩
function applyContentSize(agent, bubbleH, actionsH) {
  const rt = runtime[agent];
  const win = rt.win;
  if (!win || win.isDestroyed()) return;
  const { w, h: baseH } = winSize();
  const extraMax = Math.round(baseH * 0.85); // 兜底上限,超长内容靠气泡内层渐隐裁切
  const extra = Math.max(0, Math.min(extraMax, Math.ceil((bubbleH || 0) + (actionsH || 0))));
  if (extra === rt.extra) return;
  const [x, y] = win.getPosition();
  const [, curH] = win.getSize();
  const newH = baseH + extra;
  win.setBounds({ x, y: y + (curH - newH), width: w, height: newH });
  rt.extra = extra;
}

// 完整演示:依次展示所有状态和气泡(带序号标签),期间屏蔽该宠的真实事件
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

function demoTarget() {
  return runtime.claude.win ? 'claude' : (runtime.codex.win ? 'codex' : null);
}

async function runDemo() {
  if (demoAgent) return;
  const agent = demoTarget();
  if (!agent) return;
  demoAgent = agent;
  for (const step of DEMO_STEPS) {
    const rt = runtime[agent];
    if (!rt.win || rt.win.isDestroyed()) break;
    pushUpdate(agent, { tone: 'info', ...step });
    await new Promise((r) => setTimeout(r, step.ms));
  }
  demoAgent = null;
  pushRealState(agent);
}

function pushUpdate(agent, u) {
  const rt = runtime[agent];
  if (rt.win && !rt.win.isDestroyed() && rt.ready) rt.win.webContents.send('remi:update', u);
}

// 真实状态:claude = core 全局态 + 悬着的权限卡片(卡片优先);codex = 纯 core 全局态
function buildRealState(agent) {
  const g = runtime[agent].core.global();
  if (agent === 'claude') {
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
  }
  return { ...g, canFocus: !!g.terminal && (g.state === 'waiting' || g.state === 'done'), permission: null };
}

function pushRealState(agent) {
  if (agent !== demoAgent) pushUpdate(agent, buildRealState(agent));
}

function hookStatusLabel() {
  try { return installer.status(true).length ? '✓ Hook 已装' : 'Hook 未装'; } catch { return 'Hook 状态未知'; }
}

const fmtTokens = S.fmtTokens;

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
    tray.setToolTip('RemiPet — Claude / Codex 桌宠');
  }
  const en = agentsCfg();
  const usage = metering ? metering.today() : { tokens: 0, cost: 0 };
  const g = runtime.claude.core ? runtime.claude.core.global() : {};
  const ctxLine = g.contextTokens != null ? ` · 上下文 ${fmtTokens(g.contextTokens)}` : '';

  const sizeItems = SIZE_PRESETS.map(([label, scale]) => ({
    label,
    type: 'radio',
    checked: Math.abs(winSize().scale - scale) < 0.01,
    click: () => {
      saveConfig({ scale });
      for (const agent of AGENTS) {
        const win = runtime[agent].win;
        if (!win || win.isDestroyed()) continue;
        const [x, y] = win.getPosition();
        const [, oldH] = win.getSize();
        const { w, h } = winSize();
        win.setBounds({ x, y: y + oldH - h, width: w, height: h });
        runtime[agent].extra = 0;
        pushRealState(agent); // 宽度变了内容会重排,让渲染层重新上报再长高
      }
      buildTray();
    },
  }));
  const testItems = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'sleeping'].map((state) => ({
    label: state,
    click: () => {
      const agent = demoTarget();
      if (agent) pushUpdate(agent, {
        state,
        animation: S.pick(S.STATE_ANIM[state]),
        bubble: S.pick(S.STATE_BUBBLE[state]) || (state === 'working' ? S.toolBubble('Bash') : null),
        tone: state === 'error' ? 'error' : 'info',
      });
    },
  }));

  const template = [
    { label: `端口 ${serverPort ?? '未启动'} · ${hookStatusLabel()}${ctxLine}`, enabled: false },
    { label: `Claude 今日: ${fmtTokens(usage.tokens)} tokens / $${usage.cost.toFixed(2)}`, enabled: false },
  ];
  if (en.codex && codexWatcher) {
    template.push({ label: `Codex 今日: ${fmtTokens(codexWatcher.todayTokens())} tokens`, enabled: false });
  }
  template.push(
    { type: 'separator' },
    { label: '监听 Claude', type: 'checkbox', checked: en.claude, click: (item) => toggleAgent('claude', item.checked) },
    { label: '监听 Codex', type: 'checkbox', checked: en.codex, click: (item) => toggleAgent('codex', item.checked) },
    { type: 'separator' },
    { label: '显示 / 隐藏', click: () => {
      for (const agent of AGENTS) {
        const win = runtime[agent].win;
        if (win && !win.isDestroyed()) (win.isVisible() ? win.hide() : win.show());
      }
    } },
    { label: '尺寸', submenu: sizeItems },
    { label: '回到默认位置', click: () => {
      for (const agent of AGENTS) {
        const win = runtime[agent].win;
        if (!win || win.isDestroyed()) continue;
        const p = defaultPosition(agent); // 基准高度下的位置;窗口长高时把顶边再抬高同量
        const [, curH] = win.getSize();
        win.setPosition(p.x, p.y - (curH - winSize().h));
        savePetPos(agent, p.x, p.y);
      }
    } },
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
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function runInstaller(cmd) {
  try {
    if (cmd === 'install') installer.install();
    else installer.uninstall();
  } catch (err) {
    dialog.showErrorBox('RemiPet', `Hook ${cmd} 失败:\n${err.message}`);
  }
}

function createPet(agent) {
  const rt = runtime[agent];
  if (rt.win && !rt.win.isDestroyed()) return;
  const { w, h } = winSize();
  const pos = savedPosition(agent) || defaultPosition(agent);
  const win = new BrowserWindow({
    width: w, height: h, x: pos.x, y: pos.y,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'), { query: { agent } });

  let saveTimer = null;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [, curH] = win.getSize();
      // 存底边锚定的基准位置:窗口可能正因气泡长高,直接存 y 会带上临时偏移
      savePetPos(agent, x, y + (curH - winSize().h));
    }, 500);
  });
  win.on('closed', () => { rt.win = null; rt.ready = false; });
  rt.win = win;
  rt.ready = false;
  rt.extra = 0;
}

function destroyPet(agent) {
  const rt = runtime[agent];
  if (rt.win && !rt.win.isDestroyed()) rt.win.destroy();
  rt.win = null;
  rt.ready = false;
}

function toggleAgent(agent, on) {
  saveConfig({ agents: { ...agentsCfg(), [agent]: !!on } });
  if (on) {
    createPet(agent);
    if (agent === 'codex') codexWatcher.start();
  } else {
    destroyPet(agent);
    if (agent === 'codex') codexWatcher.stop();
    // 关掉 claude 监听后,悬着的权限卡片没处显示,立即放行回终端
    if (agent === 'claude') onPermChange();
  }
  buildTray();
}

// 权限卡片变化:claude 未勾选时逐张放行(decide 会再次触发本回调,自然排空)
function onPermChange() {
  if (!agentsCfg().claude) {
    const card = permissions.first();
    if (card) { permissions.decide(card.id, 'pass'); return; }
  }
  pushRealState('claude');
}

function agentOf(sender) {
  for (const agent of AGENTS) {
    const rt = runtime[agent];
    if (rt.win && !rt.win.isDestroyed() && rt.win.webContents === sender) return agent;
  }
  return null;
}

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  runtime.claude.core = new Core();
  runtime.claude.core.on('update', () => pushRealState('claude'));
  runtime.claude.core.on('session-end', (sid) => permissions.sweepSession(sid));

  runtime.codex.core = new Core();
  runtime.codex.core.on('update', () => pushRealState('codex'));
  codexWatcher = new CodexWatcher(runtime.codex.core);

  permissions = createPermissions({ onChange: onPermChange });

  metering = new Metering();
  metering.start();
  // 托盘用量行每分钟跟着刷新
  const trayTimer = setInterval(() => buildTray(), 60 * 1000);
  trayTimer.unref?.();

  const opts = { onDemo: () => runDemo(), permissions };
  if (process.env.REMI_DEBUG_SNAP === '1') {
    opts.onSnap = async (agent) => {
      const target = AGENTS.includes(agent) ? agent : demoTarget();
      const win = target && runtime[target].win;
      return win ? (await win.webContents.capturePage()).toPNG() : null;
    };
  }
  startServer(runtime.claude.core, (err, info) => {
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

  ipcMain.on('remi:ready', (e) => {
    const agent = agentOf(e.sender);
    if (!agent) return;
    runtime[agent].ready = true;
    pushRealState(agent);
  });
  ipcMain.on('remi:decide', (e, { id, behavior }) => {
    if (agentOf(e.sender) !== 'claude') return; // 一键批准只属于 claude 宠
    permissions.decide(id, behavior === 'allow' ? 'allow' : 'deny');
  });
  ipcMain.on('remi:focus', (e) => {
    const agent = agentOf(e.sender);
    if (!agent) return;
    const g = runtime[agent].core.global();
    if (g.terminal) focusTerminal(g.terminal, () => {});
  });
  ipcMain.on('remi:size', (e, s) => {
    const agent = agentOf(e.sender);
    if (agent && s && typeof s === 'object') {
      applyContentSize(agent, Number(s.bubble) || 0, Number(s.actions) || 0);
    }
  });

  const en = agentsCfg();
  if (en.claude) createPet('claude');
  if (en.codex) { createPet('codex'); codexWatcher.start(); }
});

// 两个监听都关掉时窗口归零,app 靠托盘活着;退出只走托盘「退出」
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  T.clearRuntimePort();
  permissions?.cleanup();
  metering?.stop();
  codexWatcher?.stop();
  runtime.claude.core?.dispose();
  runtime.codex.core?.dispose();
});
