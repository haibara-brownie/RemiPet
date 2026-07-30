'use strict';

// 状态核心:按 session 记录 Claude Code 的状态,聚合出全局「宠物心情」,
// 变化时通过 EventEmitter 通知主进程推给渲染层。

const { EventEmitter } = require('events');
const path = require('path');
const S = require('../shared/states');

const SESSION_STALE_MS = 60 * 60 * 1000; // 一小时没动静的会话直接遗忘
const SNIPPET_BUBBLE_MAX = 60;           // 完工气泡里的回复摘要长度(小窗容不下更多)
const CTX_SHOW_TOKENS = 150000;          // 上下文用量超过该值开始在气泡里标注真实数字
const CTX_WARN_PERCENT = 75;             // percent 有真凭据且超过该值才转 warn(避免窗口猜错误报)

class Core extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // sid → {state, bubble, tone, cwd, terminal, contextPercent, lastEventMs, expiresAt, anim}
    this.lastActivityMs = Date.now();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.lastEmitted = null;
  }

  // hook POST 进来的事件体
  handleEvent(body) {
    const sid = body.session_id;
    const now = Date.now();
    this.lastActivityMs = now;

    if (body.event === 'SessionEnd') {
      this.sessions.delete(sid);
      this.emit('session-end', sid);
      this.recompute();
      return;
    }

    const state = body.state;
    const sess = this.sessions.get(sid) || {};
    const entering = sess.state !== state;
    sess.state = state;
    sess.lastEventMs = now;
    if (body.cwd) sess.cwd = body.cwd;
    if (body.terminal) sess.terminal = body.terminal;
    if (body.context) {
      sess.contextTokens = body.context.used ?? null;
      sess.contextPercent = body.context.percent ?? null;
    }

    if (body.event === 'SessionStart') {
      sess.bubble = body.source === 'startup' ? '哦?你来了' : null;
      sess.tone = 'info';
    } else if (state === 'thinking' && body.emotion && S.EMOTION_BUBBLE[body.emotion]) {
      // 被夸/被谢/被凶:先给个情绪反应,动画也跟着换
      sess.bubble = S.pick(S.EMOTION_BUBBLE[body.emotion]);
      sess.tone = 'info';
      sess.emotionAnim = S.EMOTION_ANIM[body.emotion];
    } else if (state === 'working') {
      sess.bubble = body.tool_name === 'Task'
        ? S.pick(['召唤了小弟干活!', '分身,上!'])
        : (body.event === 'SubagentStop' ? '小弟干完活回来了' : S.toolBubble(body.tool_name));
      sess.tone = 'info';
    } else if (state === 'waiting') {
      sess.bubble = this.notificationBubble(body.message);
      sess.tone = /permission|批准/i.test(body.message || '') ? 'warn' : 'info';
    } else if (state === 'error') {
      const base = S.pick(S.STATE_BUBBLE.error);
      sess.bubble = body.error_type ? `${base}(${S.errorLabel(body.error_type)})` : base;
      sess.tone = 'error';
    } else if (state === 'done') {
      let bubble = S.pick(S.STATE_BUBBLE.done);
      if (typeof body.assistant_last === 'string' && body.assistant_last) {
        const snip = body.assistant_last.length > SNIPPET_BUBBLE_MAX
          ? body.assistant_last.slice(0, SNIPPET_BUBBLE_MAX) + '…'
          : body.assistant_last;
        bubble = `${bubble}\n「${snip}」`;
      }
      sess.bubble = bubble;
      sess.tone = 'info';
    } else if (entering) {
      sess.bubble = S.pick(S.STATE_BUBBLE[state] || null);
      sess.tone = 'info';
    }

    // 动画:working 按工具类型;情绪反应临时换装;其余进入状态时定格
    if (state === 'working') sess.anim = S.toolAnim(body.tool_name);
    else if (state === 'thinking' && sess.emotionAnim) { sess.anim = sess.emotionAnim; sess.emotionAnim = null; }
    else if (entering || !sess.anim) sess.anim = S.pick(S.STATE_ANIM[state] || S.STATE_ANIM.idle);

    // 到期回落
    if (S.ONESHOT_TTL_MS[state]) sess.expiresAt = now + S.ONESHOT_TTL_MS[state];
    else if (S.BUSY_STATES.includes(state)) sess.expiresAt = now + S.BUSY_TTL_MS;
    else sess.expiresAt = null;

    this.sessions.set(sid, sess);
    this.recompute();
  }

  notificationBubble(message) {
    if (typeof message === 'string' && message) {
      const m = message.match(/permission to use (\w+)/i);
      if (m) return `快!蕾米想用 ${m[1]},等你点头!`;
      if (/waiting for your input/i.test(message)) return '蕾米在等你回话哦~';
      return message;
    }
    return S.pick(S.STATE_BUBBLE.waiting);
  }

  tick() {
    const now = Date.now();
    let dirty = false;
    for (const [sid, sess] of this.sessions) {
      if (now - sess.lastEventMs > SESSION_STALE_MS) { this.sessions.delete(sid); dirty = true; continue; }
      if (sess.expiresAt && now >= sess.expiresAt) {
        sess.state = 'idle';
        sess.bubble = null;
        sess.anim = S.pick(S.STATE_ANIM.idle);
        sess.expiresAt = null;
        dirty = true;
      }
    }
    if (dirty || now - this.lastActivityMs > S.SLEEPY_AFTER_MS) this.recompute();
  }

  winner() {
    let winner = null;
    for (const sess of this.sessions.values()) {
      if (!winner || (S.STATE_PRIORITY[sess.state] || 0) > (S.STATE_PRIORITY[winner.state] || 0)) winner = sess;
    }
    return winner;
  }

  global() {
    const winner = this.winner();
    if (!winner || (winner.state === 'idle' && Date.now() - this.lastActivityMs > S.SLEEPY_AFTER_MS)) {
      return { state: 'sleeping', animation: S.STATE_ANIM.sleeping[0], bubble: null, tone: 'info' };
    }
    let bubble = winner.bubble || null;
    if (bubble && this.sessions.size > 1 && winner.cwd) {
      bubble = `[${path.basename(winner.cwd)}] ${bubble}`;
    }
    // 上下文提醒在展示时才拼接(存起来会被同状态的后续事件反复追加成好几行):
    // 报真实 tokens 不报百分比;warn 只在 percent 有真凭据(1M 标记/超 200k)时触发
    let tone = winner.tone || 'info';
    const ctxHot = winner.contextPercent != null && winner.contextPercent >= CTX_WARN_PERCENT;
    if (bubble && winner.state !== 'error' && winner.contextTokens
        && (winner.contextTokens >= CTX_SHOW_TOKENS || ctxHot)) {
      bubble += `\n(上下文已用 ${S.fmtTokens(winner.contextTokens)})`;
      if (ctxHot && tone === 'info') tone = 'warn';
    }
    return {
      state: winner.state,
      animation: winner.anim,
      bubble,
      tone,
      terminal: winner.terminal || null,
      contextTokens: winner.contextTokens ?? null,
      contextPercent: winner.contextPercent ?? null,
    };
  }

  recompute() {
    const g = this.global();
    const key = JSON.stringify(g);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.emit('update', g);
  }

  // 供主进程在权限卡片变化时强制重推
  poke() {
    this.lastEmitted = null;
    this.recompute();
  }

  dispose() { clearInterval(this.timer); }
}

module.exports = { Core };
