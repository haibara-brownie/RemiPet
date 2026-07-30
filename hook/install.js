#!/usr/bin/env node
'use strict';

// merge-safe 的 Claude Code hook 安装器。
// 只增改 command 里含 remi-hook.js 的条目,其他 hook 一个字节都不碰;
// 首次改动前备份;写入走 tmp+rename 原子替换。
// 用法: node hook/install.js install|uninstall|status

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { PORTS, BASE_PORT } = require('../backend/transport');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// hook 脚本必须是文件系统上的真实路径 —— Claude Code 用系统 node 直接执行它,
// 而打包后代码在 app.asar 里,node 进不去。打包配置用 extraResources 把
// hook/ + backend/ 原样复制到 Contents/Resources/pet-hook/,这里解析到那份。
function resolveHookScript() {
  if (__dirname.includes('app.asar')) {
    return path.join(process.resourcesPath, 'pet-hook', 'hook', 'remi-hook.js');
  }
  return path.join(__dirname, 'remi-hook.js');
}
const HOOK_SCRIPT = resolveHookScript();
const MARKER = 'remi-hook.js';
const TIMEOUT_S = 5;
const PERMISSION_TIMEOUT_S = 600;

const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'StopFailure',
  'Notification', 'PreCompact', 'PostCompact',
];

function permissionUrl(port) { return `http://127.0.0.1:${port}/permission`; }
// 识别所有端口候选上的自家 http hook
const PERM_URLS = new Set(PORTS.map(permissionUrl));

function resolveNodeBin() {
  const base = path.basename(process.execPath);
  if (base === 'node' || base === 'node.exe') return process.execPath;
  const guesses = [
    '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
  ];
  // nvm 安装的 node 不在固定路径,用登录 shell 找
  try {
    const p = execSync('/bin/zsh -lc "which node"', { encoding: 'utf8', timeout: 5000 }).trim();
    if (p) guesses.unshift(p);
  } catch {}
  for (const g of guesses) {
    try { fs.accessSync(g, fs.constants.X_OK); return g; } catch {}
  }
  throw new Error('找不到 node,可先执行 npm run install-hook(用 node 直接跑安装器)');
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`读取 settings.json 失败: ${err.message}`);
  }
}

function writeAtomic(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = path.join(path.dirname(SETTINGS_PATH), `.settings.remi.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function backupOnce() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const bak = SETTINGS_PATH + '.remi-backup';
  if (!fs.existsSync(bak)) fs.copyFileSync(SETTINGS_PATH, bak);
  return bak;
}

function isOurs(hookObj) {
  if (!hookObj) return false;
  if (typeof hookObj.command === 'string' && hookObj.command.includes(MARKER)) return true;
  // 本机回环上的 /permission 都视作自家条目(兼容历史坏 URL,便于原地修复)
  if (hookObj.type === 'http' && /^http:\/\/127\.0\.0\.1:[^/]+\/permission$/.test(String(hookObj.url))) return true;
  return false;
}

function commandHook(nodeBin, event) {
  const cmd = `"${nodeBin}" "${HOOK_SCRIPT}" ${event}`;
  if (process.platform === 'win32') {
    return { type: 'command', shell: 'powershell', command: `& ${cmd}`, timeout: TIMEOUT_S };
  }
  return { type: 'command', command: cmd, timeout: TIMEOUT_S };
}

// 确保 settings.hooks[event] 里有且仅有一份我们的条目,内容与 desired 一致
function syncEvent(hooks, event, desired) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const groups = hooks[event];
  let found = false;
  let changed = false;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (let i = 0; i < group.hooks.length; i++) {
      if (!isOurs(group.hooks[i])) continue;
      found = true;
      if (JSON.stringify(group.hooks[i]) !== JSON.stringify(desired)) {
        group.hooks[i] = desired;
        changed = true;
      }
    }
  }
  if (!found) {
    groups.push({ matcher: '', hooks: [desired] });
    changed = true;
  }
  return changed;
}

function install() {
  const nodeBin = resolveNodeBin();
  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let changed = false;

  for (const event of EVENTS) {
    if (syncEvent(settings.hooks, event, commandHook(nodeBin, event))) changed = true;
  }
  // 阻塞式权限 hook:CC 挂起等宠物答复;宠物没在跑连接立刻失败,CC 走终端流程
  const httpDesired = { type: 'http', url: permissionUrl(BASE_PORT), timeout: PERMISSION_TIMEOUT_S };
  if (syncEvent(settings.hooks, 'PermissionRequest', httpDesired)) changed = true;

  if (changed) {
    const bak = backupOnce();
    writeAtomic(settings);
    console.log(`✅ hook 已注册到 ${SETTINGS_PATH}(${EVENTS.length} 个事件 + PermissionRequest)`);
    if (bak) console.log(`   原文件备份在 ${bak}`);
    console.log('   新开的 claude 会话即刻生效;已开着的会话需重启才会带上 hook。');
  } else {
    console.log('✅ hook 已是最新,无需改动');
  }
}

function uninstall() {
  const settings = readSettings();
  if (!settings.hooks) return console.log('没有安装过 hook');
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !isOurs(h));
      if (group.hooks.length !== before) changed = true;
    }
    settings.hooks[event] = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (changed) {
    backupOnce();
    writeAtomic(settings);
    console.log('✅ hook 已全部移除');
  } else {
    console.log('没有找到本宠物的 hook');
  }
}

// quiet=true 时不打印(主进程构建托盘菜单会频繁调用,不能刷日志)
function status(quiet) {
  const settings = readSettings();
  const installed = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && Array.isArray(g.hooks) && g.hooks.some(isOurs)) installed.push(event);
    }
  }
  if (!quiet) console.log(installed.length ? `已安装事件: ${installed.join(', ')}` : '未安装');
  return installed;
}

if (require.main === module) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'install') install();
    else if (cmd === 'uninstall') uninstall();
    else if (cmd === 'status') status();
    else { console.log('用法: node hook/install.js install|uninstall|status'); process.exit(1); }
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

module.exports = { install, uninstall, status, SETTINGS_PATH, EVENTS };
