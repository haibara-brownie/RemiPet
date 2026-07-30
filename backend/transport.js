'use strict';

// hook 与宠物 app 之间的本地传输约定:端口段、运行时端口记录文件、POST 协议。
// hook 侧必须快速失败,绝不拖慢 Claude Code。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_ID = 'remi-pet';
const SERVER_HEADER = 'x-remi-pet';
const BASE_PORT = 41560;
const PORTS = [0, 1, 2, 3, 4].map((i) => BASE_PORT + i);
const RUNTIME_DIR = path.join(os.homedir(), '.remi-pet');
const RUNTIME_PATH = path.join(RUNTIME_DIR, 'runtime.json');
const POST_TIMEOUT_MS = 150;

function inRange(port) {
  const p = Number(port);
  return Number.isInteger(p) && PORTS.includes(p) ? p : null;
}

function readRuntimePort() {
  try {
    return inRange(JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8')).port);
  } catch { return null; }
}

function writeRuntimePort(port) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = path.join(RUNTIME_DIR, `.runtime.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ app: SERVER_ID, port }));
    fs.renameSync(tmp, RUNTIME_PATH);
  } catch {}
}

function clearRuntimePort() {
  try { fs.unlinkSync(RUNTIME_PATH); } catch {}
}

// 候选端口:运行时记录的优先
function portCandidates() {
  const out = [];
  const add = (p) => { const v = inRange(p); if (v && !out.includes(v)) out.push(v); };
  add(readRuntimePort());
  PORTS.forEach(add);
  return out;
}

// 向宠物 server POST 状态;逐端口尝试,靠响应头识别自己人。done 一定会被调用一次。
function postState(body, done) {
  const candidates = portCandidates();
  const payload = JSON.stringify(body);
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(); } };

  const tryNext = (i) => {
    if (finished || i >= candidates.length) return finish();
    const req = http.request({
      host: '127.0.0.1', port: candidates[i], path: '/state', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: POST_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      if (res.headers[SERVER_HEADER] === SERVER_ID) finish();
      else tryNext(i + 1);
    });
    req.on('timeout', () => { req.destroy(); tryNext(i + 1); });
    req.on('error', () => tryNext(i + 1));
    req.end(payload);
  };
  tryNext(0);
}

module.exports = {
  SERVER_ID, SERVER_HEADER, BASE_PORT, PORTS, RUNTIME_PATH,
  readRuntimePort, writeRuntimePort, clearRuntimePort, portCandidates, postState,
};
