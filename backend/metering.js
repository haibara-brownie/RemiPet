'use strict';

// Token 用量与费用统计(思路同 ccusage):增量扫描 ~/.claude/projects/**/*.jsonl,
// 只读 token 数/模型/时间戳,按 message.id 去重(流式写入会把同一条消息写多行),
// 按天聚合并计价,持久化到 ~/.remi-pet/usage.json。

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const STATE_PATH = path.join(os.homedir(), '.remi-pet', 'usage.json');
const BACKFILL_MS = 3 * 24 * 60 * 60 * 1000; // 首次运行回填最近 3 天
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;
const KEEP_DAYS = 60;

// USD / 1M tokens(cache 写=1.25×input,读=0.1×input)
// 价格来源:platform.claude.com 2026-06 价目;可用 ~/.remi-pet/pricing.json 覆盖
const PRICING = [
  { match: /fable|mythos/, input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  { match: /opus-(5|4-8|4-7|4-6|4-5)/, input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { match: /opus/, input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { match: /sonnet/, input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { match: /haiku/, input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
];
const PRICE_DEFAULT = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  // 用户覆盖表
  try {
    const o = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.remi-pet', 'pricing.json'), 'utf8'));
    for (const [k, v] of Object.entries(o)) {
      if (m.includes(k.toLowerCase()) && Number.isFinite(v.input)) return v;
    }
  } catch {}
  for (const row of PRICING) if (row.match.test(m)) return row;
  return PRICE_DEFAULT;
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Metering {
  constructor() {
    this.state = this.load();
    this.timer = null;
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (s && typeof s === 'object') {
        s.cursors = s.cursors || {};
        s.seen = s.seen || {};
        s.daily = s.daily || {};
        return s;
      }
    } catch {}
    return { cursors: {}, seen: {}, daily: {} };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      const tmp = STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, STATE_PATH);
    } catch {}
  }

  start(intervalMs = 60 * 1000) {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  listTranscripts() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
    for (const d of dirs) {
      const dir = path.join(PROJECTS_DIR, d);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
      }
    }
    return out;
  }

  scan() {
    const now = Date.now();
    let dirty = false;
    const files = this.listTranscripts();
    for (const file of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const cur = this.state.cursors[file];
      if (cur && cur.size === st.size) continue;
      // 新文件:太老的不回填
      if (!cur && now - st.mtimeMs > BACKFILL_MS) {
        this.state.cursors[file] = { size: st.size };
        dirty = true;
        continue;
      }
      const from = cur && cur.size < st.size ? cur.size : 0; // 变小说明被重写,从头来
      try {
        this.ingest(file, from, st.size);
        this.state.cursors[file] = { size: st.size };
        dirty = true;
      } catch {}
    }
    // 清理:seen 过期、daily 只留 KEEP_DAYS、消失文件的游标
    const existing = new Set(files);
    for (const file of Object.keys(this.state.cursors)) {
      if (!existing.has(file)) { delete this.state.cursors[file]; dirty = true; }
    }
    for (const [id, ts] of Object.entries(this.state.seen)) {
      if (now - ts > SEEN_TTL_MS) { delete this.state.seen[id]; dirty = true; }
    }
    const days = Object.keys(this.state.daily).sort();
    while (days.length > KEEP_DAYS) { delete this.state.daily[days.shift()]; dirty = true; }
    if (dirty) this.save();
  }

  ingest(file, from, to) {
    const fd = fs.openSync(file, 'r');
    try {
      const len = to - from;
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, from);
      let text = buf.toString('utf8');
      if (from > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== 'assistant' || !e.message || !e.message.usage) continue;
        const id = e.message.id;
        if (typeof id !== 'string' || !id) continue;
        if (this.state.seen[id]) continue;
        const ts = Date.parse(e.timestamp || '') || Date.now();
        this.state.seen[id] = ts;
        const u = e.message.usage;
        this.add(localDay(ts), e.message.model, {
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cacheWrite: Number(u.cache_creation_input_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0,
        });
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  add(day, model, t) {
    const d = this.state.daily[day] || (this.state.daily[day] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    d.input += t.input;
    d.output += t.output;
    d.cacheWrite += t.cacheWrite;
    d.cacheRead += t.cacheRead;
    const p = priceFor(model);
    d.cost += (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;
  }

  today() {
    const d = this.state.daily[localDay(Date.now())];
    if (!d) return { tokens: 0, output: 0, cost: 0 };
    return { tokens: d.input + d.output + d.cacheWrite + d.cacheRead, output: d.output, cost: d.cost };
  }
}

module.exports = { Metering };
