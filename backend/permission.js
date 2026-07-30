'use strict';

// Claude Code 阻塞式 PermissionRequest hook 的登记处。
//
// CC 往 /permission POST 后挂起连接等我们写回决定:
//   { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {behavior, message?} } }
// 关键安全语义:
//   - 不作答直接 destroy 连接 → CC 回落到它自己的终端提示,绝不卡死用户
//   - 用户在终端先答了 → CC 主动断开挂起连接,close 回调清掉卡片
//   - 自动超时(早于 CC 的 600s hook 超时)→ destroy 放行
// 协议格式是 Claude Code 的公开 hook 接口;实现为本项目原创。

const crypto = require('crypto');
const { SERVER_HEADER, SERVER_ID } = require('./transport');

// 纯编排类工具,直接放行,宠物不掺和
const PASSTHROUGH_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
]);

const AUTO_CLOSE_MS = 8 * 60 * 1000;

function writeDecision(res, decision) {
  try {
    res.writeHead(200, { 'content-type': 'application/json', [SERVER_HEADER]: SERVER_ID });
    res.end(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
    }));
  } catch {}
}

function destroy(res) { try { res.destroy(); } catch {} }

function requestSig(sessionId, toolName, toolInput) {
  let inp = '';
  try { inp = JSON.stringify(toolInput); } catch {}
  return `${sessionId}|${toolName}|${inp.slice(0, 2000)}`;
}

function createPermissions({ onChange } = {}) {
  const notify = typeof onChange === 'function' ? onChange : () => {};
  const pending = new Map(); // id → entry

  // 解决一张卡片:'allow' | 'deny' | 'pass'(pass = 不作答,放回终端)
  function resolve(entry, behavior, message) {
    if (!pending.has(entry.id)) return false;
    pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (entry.res && entry.closeHandler) { try { entry.res.off('close', entry.closeHandler); } catch {} }

    const writeTo = (res) => {
      if (!res || res.writableEnded || res.destroyed) return;
      if (behavior === 'pass') return destroy(res);
      const decision = { behavior };
      if (behavior === 'deny' && message) decision.message = message;
      writeDecision(res, decision);
    };
    writeTo(entry.res);
    for (const d of entry.dupes) {
      try { if (d.res && d.closeHandler) d.res.off('close', d.closeHandler); } catch {}
      writeTo(d.res);
    }
    notify();
    return true;
  }

  function attachPrimary(entry, res) {
    entry.res = res;
    entry.closeHandler = () => {
      if (!pending.has(entry.id) || res.writableFinished) return;
      // 主连接断了(通常是用户在终端答了):有重复连接就顶上,否则撤卡
      while (entry.dupes.length) {
        const next = entry.dupes.shift();
        try { if (next.res && next.closeHandler) next.res.off('close', next.closeHandler); } catch {}
        if (!next.res || next.res.destroyed || next.res.writableEnded) continue;
        attachPrimary(entry, next.res);
        return;
      }
      pending.delete(entry.id);
      clearTimeout(entry.timer);
      notify();
    };
    if (!res || res.destroyed || res.writableEnded) { entry.closeHandler(); return; }
    try { res.on('close', entry.closeHandler); } catch {}
  }

  // /permission 路由入口。parsed: {toolName, toolInput, sessionId, cwd}
  function add(res, parsed) {
    const toolName = parsed.toolName || 'Unknown';
    if (PASSTHROUGH_TOOLS.has(toolName)) return writeDecision(res, { behavior: 'allow' });
    // AskUserQuestion 选项交互在终端里体验最好,直接放回去
    if (toolName === 'AskUserQuestion') return destroy(res);

    const sig = requestSig(parsed.sessionId, toolName, parsed.toolInput);
    for (const e of pending.values()) {
      if (e.sig === sig) {
        // CC 重发的同一请求:挂到现有卡片上,一次点击答复所有副本
        const dup = { res, closeHandler: null };
        dup.closeHandler = () => { const i = e.dupes.indexOf(dup); if (i >= 0) e.dupes.splice(i, 1); };
        e.dupes.push(dup);
        try { res.on('close', dup.closeHandler); } catch {}
        return;
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      sig,
      res: null,
      dupes: [],
      closeHandler: null,
      sessionId: parsed.sessionId,
      toolName,
      toolInput: parsed.toolInput,
      cwd: parsed.cwd || null,
      createdAt: Date.now(),
      timer: null,
    };
    pending.set(entry.id, entry);
    attachPrimary(entry, res);
    if (!pending.has(entry.id)) return;
    entry.timer = setTimeout(() => resolve(entry, 'pass'), AUTO_CLOSE_MS);
    entry.timer.unref?.();
    notify();
  }

  function decide(id, behavior) {
    const entry = pending.get(id);
    if (!entry) return false;
    if (behavior === 'allow') return resolve(entry, 'allow');
    if (behavior === 'deny') return resolve(entry, 'deny', '用户在桌宠上拒绝了');
    return resolve(entry, 'pass');
  }

  // SessionEnd 时清掉该会话的悬卡
  function sweepSession(sessionId) {
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sessionId) resolve(entry, 'pass');
    }
  }

  function first() {
    let oldest = null;
    for (const e of pending.values()) {
      if (!oldest || e.createdAt < oldest.createdAt) oldest = e;
    }
    return oldest ? { id: oldest.id, toolName: oldest.toolName, cwd: oldest.cwd, count: pending.size } : null;
  }

  function cleanup() {
    for (const entry of [...pending.values()]) resolve(entry, 'pass');
  }

  return { add, decide, sweepSession, first, cleanup, size: () => pending.size };
}

module.exports = { createPermissions };
