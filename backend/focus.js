'use strict';

// 「去回复」:聚焦 Claude Code 会话所在的终端/IDE 窗口。
//
// mac 用 System Events 把「正在运行」的进程调到前台——绝不启动新实例
// (open -b / activate 都会在应用没开时新开一个,这里刻意不用)。
// Terminal.app 和 iTerm2 还能按 tty 精确选中会话所在的那个标签页。
// 首次使用 macOS 会弹「自动化」授权,允许一次即可。

const { execFile } = require('child_process');

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

// terminal: hook 上报的 {bundle_id, term_program, tty, tmux}
function focusTerminal(terminal, cb = () => {}) {
  const t = terminal || {};
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
