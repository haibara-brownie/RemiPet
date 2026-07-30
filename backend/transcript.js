'use strict';

// Claude Code 会话记录(JSONL)解析:只读尾部,提取
//   - 最后一条助手回复(完工气泡展示摘要)
//   - 上下文占用(最新助手消息的 input+cache token 之和)
//   - 当前轮的 API 错误(isApiErrorMessage 标记)
// 字段名是 Claude Code 的数据接口;只在本机读取,不外传。

const fs = require('fs');

const TAIL_BYTES = 256 * 1024;
const SNIPPET_MAX = 400;
const CTX_LIMIT = 200000;
const CTX_LIMIT_1M = 1000000;
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+', 'g');

function readTail(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let fd = null;
  try {
    const st = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    const lines = buf.toString('utf8').split('\n');
    if (st.size > len && lines.length > 1) lines.shift(); // 掐掉半行
    const out = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (o && typeof o === 'object') out.push(o);
      } catch {}
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function matchesSession(e, sid) {
  if (!sid) return true;
  return !e.sessionId || e.sessionId === sid;
}

function isSubagent(e) {
  return e.isSidechain === true || e.isSubagent === true;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, ' ')
    .trim();
}

// 当前轮最后一条助手文本(碰到用户消息即停,不跨轮)
function lastAssistantText(entries, sid) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'user' && matchesSession(e, sid)) break;
    if (e.type !== 'assistant' || e.isApiErrorMessage === true) continue;
    if (!matchesSession(e, sid) || isSubagent(e)) continue;
    const txt = clean(textFromContent(e.message ? e.message.content : e.content));
    if (!txt) continue;
    return txt.length > SNIPPET_MAX ? txt.slice(0, SNIPPET_MAX) + '…' : txt;
  }
  return null;
}

// 上下文占用:最新助手消息 usage 的 input+cache 读写之和。
// 单次请求不可能超过窗口,观测值超过 200k 说明在 1M 窗口上。
function contextUsage(entries, sid) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== 'assistant' || e.isApiErrorMessage === true) continue;
    if (!matchesSession(e, sid) || isSubagent(e)) continue;
    const u = e.message && e.message.usage;
    if (!u) continue;
    const used = (Number(u.input_tokens) || 0)
      + (Number(u.cache_read_input_tokens) || 0)
      + (Number(u.cache_creation_input_tokens) || 0);
    if (used <= 0) continue;
    const model = String((e.message && e.message.model) || '').toLowerCase();
    const limit = (used > CTX_LIMIT || /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(model)) ? CTX_LIMIT_1M : CTX_LIMIT;
    return { used, limit, percent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))) };
  }
  return null;
}

// 当前轮未恢复的 API 错误(之后没有正常消息才算数)
function apiError(entries, sid) {
  if (!Array.isArray(entries) || !sid) return null;
  let idx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i] && entries[i].isApiErrorMessage === true && entries[i].sessionId === sid) { idx = i; break; }
  }
  if (idx < 0) return null;
  for (let i = idx + 1; i < entries.length; i++) {
    const t = entries[i] && entries[i].type;
    if (t === 'user') return null;
    if (t === 'assistant' && entries[i].isApiErrorMessage !== true) return null;
  }
  return { errorType: typeof entries[idx].error === 'string' ? entries[idx].error : 'unknown' };
}

module.exports = { readTail, lastAssistantText, contextUsage, apiError, clean, textFromContent };
