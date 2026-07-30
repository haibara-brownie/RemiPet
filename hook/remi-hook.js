#!/usr/bin/env node
'use strict';

// Claude Code hook 入口:node remi-hook.js <Event>
// 读 stdin 的事件 JSON → 映射成宠物状态 → POST 给本地宠物 server。
// 必须快、绝不抛错、绝不拖住 Claude Code。

const { postState } = require('../backend/transport');
const transcript = require('../backend/transcript');
const { detectEmotion } = require('../shared/states');

const EVENT_STATE = {
  SessionStart: 'idle',
  SessionEnd: 'idle',        // 特判:core 里按 event 删除会话
  UserPromptSubmit: 'thinking',
  PreToolUse: 'working',
  PostToolUse: 'working',
  SubagentStop: 'working',
  Stop: 'done',
  StopFailure: 'error',
  Notification: 'waiting',
  PreCompact: 'compacting',
  PostCompact: 'thinking',
};

// 只在这些事件上读 transcript(PreToolUse 太频繁,不读)
const TRANSCRIPT_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Notification', 'PostCompact']);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let payload = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) payload = JSON.parse(raw);
      } catch {}
      resolve(payload);
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 300);
  });
}

function buildBody(event, p) {
  const state = EVENT_STATE[event];
  if (!state) return null;
  if (typeof p.session_id !== 'string' || !p.session_id) return null;

  const body = { state, event, session_id: p.session_id };
  if (typeof p.cwd === 'string' && p.cwd) body.cwd = p.cwd;
  if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
  if (typeof p.message === 'string' && p.message) body.message = p.message;
  if (event === 'SessionStart' && typeof p.source === 'string') body.source = p.source;
  if (event === 'StopFailure') {
    const t = p.api_error_type || p.error || p.reason;
    if (typeof t === 'string' && t) body.error_type = t;
  }

  // 终端归属(「去回复」用):bundle id 从会话环境变量继承;
  // tty 取父进程(claude)的,Terminal.app/iTerm2 可按它精确选中标签页
  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    const term = {};
    if (process.env.__CFBundleIdentifier) term.bundle_id = process.env.__CFBundleIdentifier;
    if (process.env.TERM_PROGRAM) term.term_program = process.env.TERM_PROGRAM;
    if (process.env.TMUX) term.tmux = true;
    if (process.platform === 'darwin') {
      try {
        const tty = require('child_process')
          .execSync(`ps -o tty= -p ${process.ppid}`, { timeout: 500 }).toString().trim();
        if (tty && tty !== '??' && tty !== '-') term.tty = '/dev/' + tty;
      } catch {}
    }
    if (Object.keys(term).length) body.terminal = term;
  }

  if (event === 'UserPromptSubmit') {
    const emo = detectEmotion(p.prompt);
    if (emo) body.emotion = emo;
  }

  // transcript 尾部增强:上下文占用 / 回复摘要 / API 错误
  if (TRANSCRIPT_EVENTS.has(event)) {
    const entries = transcript.readTail(p.transcript_path);
    if (entries) {
      const ctx = transcript.contextUsage(entries, p.session_id);
      if (ctx) body.context = ctx;
      if (event === 'Stop') {
        const err = transcript.apiError(entries, p.session_id);
        if (err) {
          body.state = 'error';
          body.error_type = err.errorType;
        } else {
          const text = transcript.lastAssistantText(entries, p.session_id);
          if (text) body.assistant_last = text;
        }
      }
    }
  }
  return body;
}

function main() {
  const event = process.argv[2];
  if (!EVENT_STATE[event]) process.exit(0);
  readStdin().then((payload) => {
    let body = null;
    try { body = buildBody(event, payload || {}); } catch {}
    if (!body) process.exit(0);
    postState(body, () => process.exit(0));
    setTimeout(() => process.exit(0), 600); // 兜底,绝不挂住
  }).catch(() => process.exit(0));
}

if (require.main === module) main();
module.exports = { buildBody, EVENT_STATE, detectEmotion };
