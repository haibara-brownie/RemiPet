'use strict';

// 「去回复」:聚焦 Claude Code 会话所在的终端/IDE 窗口。
//
// mac 用 System Events 把「正在运行」的进程调到前台——绝不启动新实例
// (open -b / activate 都会在应用没开时新开一个,这里刻意不用)。
// Terminal.app 和 iTerm2 还能按 tty 精确选中会话所在的那个标签页。
// 首次使用 macOS 会弹「自动化」授权,允许一次即可。

const { execFile } = require('child_process');
const path = require('path');

// TERM_PROGRAM → bundle id 兜底表(mac;__CFBundleIdentifier 缺失时用)
const TERM_BUNDLES = {
  'Apple_Terminal': 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  'WezTerm': 'com.github.wez.wezterm',
  'kitty': 'net.kovidgoyal.kitty',
  'Alacritty': 'org.alacritty',
  'ghostty': 'com.mitchellh.ghostty',
  'WarpTerminal': 'dev.warp.Warp',
  'vscode': 'com.microsoft.VSCode',
};

function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// Terminal.app:选中 tty 对应的标签页再前置
function terminalAppScript(tty) {
  return `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${esc(tty)}" then
        set selected tab of w to t
        set index of w to 1
      end if
    end repeat
  end repeat
end tell
tell application "System Events" to set frontmost of (first application process whose bundle identifier is "com.apple.Terminal") to true`;
}

// iTerm2:按 session 的 tty 精确选中
function itermScript(tty) {
  return `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${esc(tty)}" then
          select w
          tell w to select t
          tell t to select s
        end if
      end repeat
    end repeat
  end repeat
end tell
tell application "System Events" to set frontmost of (first application process whose bundle identifier is "com.googlecode.iterm2") to true`;
}

function frontmostScript(bundle) {
  return `tell application "System Events" to set frontmost of (first application process whose bundle identifier is "${esc(bundle)}") to true`;
}

// Codex CLI 会话:rollout 里没有终端身份,点击时按进程反查 ——
// 找 cwd 匹配的 codex 进程 → 沿 PPID 链找 .app 祖先拿 bundle id → 走现有聚焦逻辑。
// 全程只读只查,找不到就报错,绝不启动新实例。
function focusCodexCli(cwd, cb) {
  if (process.platform !== 'darwin') return cb(new Error('该平台暂不支持 CLI 聚焦'));
  execFile('ps', ['-axo', 'pid=,ppid=,tty=,comm='], { timeout: 3000 }, (err, out) => {
    if (err) return cb(err);
    const procs = new Map();
    for (const line of String(out).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], comm: m[4].trim() });
    }
    const codexPids = [...procs.entries()]
      .filter(([, p]) => /(^|\/)codex$/.test(p.comm))
      .map(([pid]) => pid);
    if (!codexPids.length) return cb(new Error('没有在跑的 codex CLI 进程'));

    // 多个 codex 进程时用 cwd 挑会话对应的那个。
    // 挑不出来时宁可不动 —— 聚焦错窗口会把用户从全屏里拽出来,比没反应更糟。
    const pickByCwd = (pids, done) => {
      if (pids.length === 1) return done(pids[0]);
      if (!cwd) return done(null);
      let idx = 0;
      const tryNext = () => {
        if (idx >= pids.length) return done(null);
        const pid = pids[idx++];
        execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (_e, o) => {
          if (String(o || '').split('\n').some((l) => l === 'n' + cwd)) return done(pid);
          tryNext();
        });
      };
      tryNext();
    };

    pickByCwd(codexPids, (pid) => {
      if (!pid) return cb(new Error('有多个 codex 进程,认不出会话在哪个里'));
      // 沿父进程链向上找宿主 .app(终端或 IDE)
      let appPath = null;
      let cur = pid;
      for (let hop = 0; hop < 20 && cur && cur !== 1; hop++) {
        const p = procs.get(cur);
        if (!p) break;
        const m = p.comm.match(/^(.*?\.app)\/Contents\/MacOS\//);
        if (m) { appPath = m[1]; break; }
        cur = p.ppid;
      }
      if (!appPath) return cb(new Error('找不到 CLI 会话所在的终端应用'));
      execFile('defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier'],
        { timeout: 3000 }, (e2, ident) => {
          if (e2) return cb(e2);
          const bundle = String(ident).trim();
          const tty = procs.get(pid) && procs.get(pid).tty !== '??' ? '/dev/' + procs.get(pid).tty : null;
          let script = frontmostScript(bundle);
          if (tty && bundle === 'com.apple.Terminal') script = terminalAppScript(tty);
          else if (tty && bundle === 'com.googlecode.iterm2') script = itermScript(tty);
          execFile('osascript', ['-e', script], { timeout: 5000 }, (e3) => cb(e3));
        });
    });
  });
}

// terminal: hook 上报的 {bundle_id, term_program, tty, tmux},
// 或 codex 适配器给的 {kind:'codex-cli', cwd} / {bundle_id}
function focusTerminal(terminal, cb = () => {}) {
  const t = terminal || {};
  if (t.kind === 'codex-cli') return focusCodexCli(t.cwd, cb);
  if (process.platform === 'darwin') {
    const bundle = t.bundle_id || TERM_BUNDLES[t.term_program];
    if (!bundle) return cb(new Error('不知道会话在哪个终端里'));
    let script = frontmostScript(bundle);
    if (t.tty && bundle === 'com.apple.Terminal') script = terminalAppScript(t.tty);
    else if (t.tty && bundle === 'com.googlecode.iterm2') script = itermScript(t.tty);
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => cb(err));
    return;
  }
  if (process.platform === 'linux') {
    // niri:等真上了 Arch 按实际 app-id 用 niri msg 精确聚焦
    if (process.env.NIRI_SOCKET) {
      execFile('niri', ['msg', 'action', 'focus-window-previous'], (err) => cb(err));
      return;
    }
    return cb(new Error('当前 Linux 合成器暂不支持聚焦'));
  }
  // Windows:后续用 PowerShell AppActivate 实现
  cb(new Error('该平台暂不支持聚焦'));
}

module.exports = { focusTerminal };
