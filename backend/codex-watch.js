'use strict';

// Codex 监听适配器:只读 tail ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
// 把 rollout 事件翻译成 hook 形状的 body 喂给 Core(复用全部聚合/气泡/TTL 逻辑)。
// CLI / ChatGPT App / VS Code 共用 CODEX_HOME,一个适配器全覆盖。
//
// 铁律:对 ~/.codex 纯只读 —— 不写文件、不碰 config.toml(notify 坑位已被
// ChatGPT App 的 Computer Use 客户端占用,抢了会弄坏用户现有功能)。

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../shared/states');

const USAGE_PATH = path.join(os.homedir(), '.remi-pet', 'codex-usage.json');

const TAIL_MS = 1000;                     // 活跃文件增量读取间隔
const RESCAN_MS = 15 * 1000;              // 重扫日目录找新文件(顺带处理跨天)
const FILE_IDLE_MS = 60 * 60 * 1000;      // 1h 无变化的文件移出活跃集
const ADOPT_WINDOW_MS = 24 * 60 * 60 * 1000; // 启动时只认 24h 内动过的文件
const HEAD_BYTES = 64 * 1024;             // 收养旧文件时读文件头找 session_meta
const WAIT_AFTER_DONE_MS = 11 * 1000;     // 完工后无动静 → 等回话(赶在 done 12s 回落前)
const WAIT_GIVEUP_MS = 5 * 60 * 1000;     // 等回话太久 → 回 idle,别挂一小时
const KEEP_DAYS = 60;
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;

function defaultSessionsDir() {
  if (process.env.REMI_CODEX_DIR) return process.env.REMI_CODEX_DIR;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 文件名自带 session id:rollout-<时间戳>-<uuid>.jsonl
function sidFromFilename(file) {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

class CodexWatcher {
  constructor(core) {
    this.core = core;
    this.dir = defaultSessionsDir();
    this.files = new Map();     // path → {sid, cwd, originator, source, ignore, cursor, leftover, lastChangeMs, ctxPercent}
    this.bySid = new Map();     // sid → 上面的 rec(等回话定时器要用)
    this.waitTimers = new Map();// sid → Timeout
    this.tailTimer = null;
    this.scanTimer = null;
    this.usage = this.loadUsage();
  }

  start() {
    if (this.tailTimer) return;
    this.rescan(true);
    this.tailTimer = setInterval(() => this.tailAll(), TAIL_MS);
    this.tailTimer.unref?.();
    this.scanTimer = setInterval(() => this.rescan(false), RESCAN_MS);
    this.scanTimer.unref?.();
  }

  stop() {
    clearInterval(this.tailTimer); this.tailTimer = null;
    clearInterval(this.scanTimer); this.scanTimer = null;
    for (const t of this.waitTimers.values()) clearTimeout(t);
    this.waitTimers.clear();
    this.files.clear();
    this.bySid.clear();
    this.saveUsage();
  }

  // —— 发现:扫今天和昨天的日目录(跨天/旧会话续写靠 rescan 周期覆盖) ——
  dayDirs() {
    const out = [];
    for (const offset of [0, 1]) {
      const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
      out.push(path.join(this.dir,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')));
    }
    return out;
  }

  rescan(initial) {
    const now = Date.now();
    for (const dir of this.dayDirs()) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue;
        const file = path.join(dir, name);
        if (this.files.has(file)) continue;
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (now - st.mtimeMs > ADOPT_WINDOW_MS) continue;
        this.adopt(file, st, initial);
      }
    }
    // 长期没动静的文件放手(Core 那边 1h 也会遗忘会话)
    for (const [file, rec] of this.files) {
      if (now - rec.lastChangeMs > FILE_IDLE_MS) {
        this.files.delete(file);
        if (rec.sid && this.bySid.get(rec.sid) === rec) this.bySid.delete(rec.sid);
      }
    }
  }

  adopt(file, st, atEnd) {
    const rec = {
      sid: sidFromFilename(file),
      cwd: null, originator: null, source: null, ignore: false,
      cursor: atEnd ? st.size : 0,   // 启动时收养的文件从末尾开始:不回放历史
      leftover: '',
      lastChangeMs: st.mtimeMs,
      ctxPercent: null,
    };
    // 从末尾开始就读不到第一行的 session_meta 了,补读文件头拿 cwd/来源/子代理标记
    if (atEnd && st.size > 0) {
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          for (const line of buf.toString('utf8').split('\n')) {
            try {
              const o = JSON.parse(line);
              if (o && o.type === 'session_meta') { this.applyMeta(rec, o.payload || {}); break; }
            } catch { /* 头块截断的行,跳过 */ }
          }
        } finally { fs.closeSync(fd); }
      } catch {}
    }
    this.files.set(file, rec);
    if (rec.sid) this.bySid.set(rec.sid, rec);
  }

  applyMeta(rec, p) {
    if (typeof p.id === 'string' && p.id) rec.sid = p.id;
    if (typeof p.cwd === 'string' && p.cwd) rec.cwd = p.cwd;
    if (p.originator != null) rec.originator = String(p.originator);
    rec.source = p.source ?? rec.source;
    // 子代理会话有独立 rollout,source 里带 subagent 描述 → 整个文件不驱动宠物
    if (p.source && typeof p.source === 'object' && p.source.subagent) rec.ignore = true;
  }

  // —— tail:字节游标读增量,leftover 缓冲拼断行 ——
  tailAll() {
    for (const [file, rec] of this.files) {
      let st;
      try { st = fs.statSync(file); } catch { this.files.delete(file); continue; }
      if (st.size === rec.cursor) continue;
      if (st.size < rec.cursor) { rec.cursor = 0; rec.leftover = ''; } // 被重写,从头来
      rec.lastChangeMs = Date.now();
      let text;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(st.size - rec.cursor);
          fs.readSync(fd, buf, 0, buf.length, rec.cursor);
          text = rec.leftover + buf.toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      rec.cursor = st.size;
      const lines = text.split('\n');
      rec.leftover = lines.pop(); // 末尾半行留到下轮
      for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        try { this.translate(rec, o); } catch {}
      }
    }
  }

  // —— 翻译:rollout 事件 → hook 形状的 body → core.handleEvent ——
  translate(rec, o) {
    const p = o.payload || {};
    if (o.type === 'session_meta') { this.applyMeta(rec, p); if (rec.sid) this.bySid.set(rec.sid, rec); return; }
    if (rec.ignore || !rec.sid) return;
    if (o.type === 'turn_context') { if (typeof p.cwd === 'string' && p.cwd) rec.cwd = p.cwd; return; }
    if (o.type === 'compacted') return this.send(rec, { state: 'compacting' });

    const pt = String(p.type || '');
    if (o.type === 'response_item') {
      if (pt === 'function_call' || pt === 'custom_tool_call') {
        return this.send(rec, { state: 'working', event: 'PreToolUse', tool_name: p.name });
      }
      return;
    }
    if (o.type !== 'event_msg') return;

    switch (pt) {
      case 'user_message': {
        const text = typeof p.message === 'string' ? p.message : null;
        const body = { state: 'thinking', event: 'UserPromptSubmit' };
        // 环境上下文之类的合成消息不做情绪嗅探
        if (text && !text.startsWith('<')) {
          const emo = S.detectEmotion(text);
          if (emo) body.emotion = emo;
        }
        return this.send(rec, body);
      }
      case 'task_started':
        return this.send(rec, { state: 'thinking' });
      case 'task_complete': {
        const body = { state: 'done', event: 'Stop' };
        if (typeof p.last_agent_message === 'string' && p.last_agent_message) {
          body.assistant_last = p.last_agent_message;
        }
        return this.send(rec, body);
      }
      case 'context_compacted':
        return this.send(rec, { state: 'compacting' });
      case 'turn_aborted':
        return this.send(rec, { state: 'idle' }); // 用户打断,相当于 Esc
      case 'token_count':
        return this.onTokenCount(rec, p);
      default:
        // 审批请求(approval_policy 开着才会出现):不出批准/拒绝,只引导「去回复」
        if (/approval/.test(pt)) {
          return this.send(rec, { state: 'waiting', message: 'Codex 在等你批准,去点一下!' });
        }
        if (/error/.test(pt)) {
          const body = { state: 'error' };
          if (typeof p.message === 'string' && p.message) body.error_type = p.message.slice(0, 24);
          return this.send(rec, body);
        }
    }
  }

  send(rec, extra) {
    const body = {
      session_id: rec.sid,
      event: extra.event || 'CodexEvent',
      cwd: rec.cwd || undefined,
      terminal: this.terminalFor(rec),
      ...extra,
    };
    if (rec.ctxPercent != null) body.context = { percent: rec.ctxPercent };
    this.core.handleEvent(body);
    this.armWaitChain(rec, extra.state);
  }

  // originator / source → 「去回复」聚焦目标
  terminalFor(rec) {
    if (rec.source === 'vscode') return { bundle_id: 'com.microsoft.VSCode' };
    if (/desktop/i.test(rec.originator || '')) return { bundle_id: 'com.openai.chat' };
    return { kind: 'codex-cli', cwd: rec.cwd || null }; // CLI:聚焦时按进程反查终端
  }

  // 完工后 Codex 其实就在等用户 → done 回落前接一句「等你回话」,再等太久就回 idle
  armWaitChain(rec, state) {
    const sid = rec.sid;
    clearTimeout(this.waitTimers.get(sid));
    this.waitTimers.delete(sid);
    if (state === 'done') {
      const t1 = setTimeout(() => {
        this.send(rec, { state: 'waiting', message: 'Waiting for your input' });
        // send 里会 clear,这里重新挂放弃定时器
        const t2 = setTimeout(() => this.send(rec, { state: 'idle' }), WAIT_GIVEUP_MS);
        t2.unref?.();
        this.waitTimers.set(sid, t2);
      }, WAIT_AFTER_DONE_MS);
      t1.unref?.();
      this.waitTimers.set(sid, t1);
    }
  }

  // —— token_count:上下文百分比 + 轻量计量(只报 tokens,不定价) ——
  onTokenCount(rec, p) {
    const info = p.info || {};
    const last = info.last_token_usage || {};
    const win = Number(info.model_context_window);
    const used = Number(last.total_tokens)
      || (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
    if (win > 0 && used > 0) {
      rec.ctxPercent = Math.max(0, Math.min(99, Math.round((used / win) * 100)));
    }
    const total = Number((info.total_token_usage || {}).total_tokens);
    if (Number.isFinite(total) && total > 0) this.meter(rec.sid, total);
  }

  meter(sid, total) {
    const seen = this.usage.lastTotals[sid];
    const now = Date.now();
    // 首次见到该会话:只记基线不计数(启动前烧掉的 tokens 归属说不清)
    if (seen) {
      const delta = total - seen.v;
      if (delta > 0) {
        const day = localDay(now);
        this.usage.daily[day] = (this.usage.daily[day] || 0) + delta;
      }
    }
    this.usage.lastTotals[sid] = { v: total, ts: now };
    if (now - (this.lastUsageSave || 0) > 30 * 1000) {
      this.lastUsageSave = now;
      this.pruneUsage();
      this.saveUsage();
    }
  }

  todayTokens() { return this.usage.daily[localDay(Date.now())] || 0; }

  loadUsage() {
    try {
      const s = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
      if (s && typeof s === 'object') {
        s.daily = s.daily || {};
        s.lastTotals = s.lastTotals || {};
        return s;
      }
    } catch {}
    return { daily: {}, lastTotals: {} };
  }

  pruneUsage() {
    const now = Date.now();
    for (const [sid, rec] of Object.entries(this.usage.lastTotals)) {
      if (now - rec.ts > SEEN_TTL_MS) delete this.usage.lastTotals[sid];
    }
    const days = Object.keys(this.usage.daily).sort();
    while (days.length > KEEP_DAYS) delete this.usage.daily[days.shift()];
  }

  saveUsage() {
    try {
      fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
      const tmp = USAGE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.usage));
      fs.renameSync(tmp, USAGE_PATH);
    } catch {}
  }
}

module.exports = { CodexWatcher };
