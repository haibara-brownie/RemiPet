'use strict';

// 本地 HTTP server:接收 hook 事件(POST /state)和阻塞式权限请求
// (POST /permission),只绑 127.0.0.1。

const http = require('http');
const S = require('../shared/states');
const T = require('./transport');

const BODY_LIMIT = 64 * 1024;
const PERMISSION_BODY_LIMIT = 256 * 1024;

function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { over = true; return; }
    chunks.push(c);
  });
  req.on('end', () => cb(over ? null : Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => cb(null));
}

function startServer(core, cb, opts = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader(T.SERVER_HEADER, T.SERVER_ID);
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ app: T.SERVER_ID, state: core.global() }));
    }
    // 触发完整演示(本机专用,只播动画,无副作用)
    if (req.method === 'GET' && req.url === '/demo' && opts.onDemo) {
      opts.onDemo();
      res.writeHead(200);
      return res.end('demo started');
    }
    // 调试用:REMI_DEBUG_SNAP=1 时开启,返回宠物窗口截图 PNG(/snap?agent=codex 指定哪只)
    if (req.method === 'GET' && req.url.startsWith('/snap') && opts.onSnap) {
      const agent = new URL(req.url, 'http://x').searchParams.get('agent');
      opts.onSnap(agent).then((png) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      }).catch((e) => { res.writeHead(500); res.end(String(e)); });
      return;
    }
    if (req.method === 'POST' && req.url === '/state') {
      readBody(req, BODY_LIMIT, (raw) => {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        const ok = body && typeof body.session_id === 'string' && body.session_id
          && typeof body.state === 'string' && S.VALID_STATES.includes(body.state);
        if (ok) { try { core.handleEvent(body); } catch (e) { console.error('handleEvent', e); } }
        res.writeHead(ok ? 200 : 400);
        res.end();
      });
      return;
    }
    // 阻塞式权限请求:挂起 res,由 permissions 模块决定何时写回
    if (req.method === 'POST' && req.url === '/permission' && opts.permissions) {
      readBody(req, PERMISSION_BODY_LIMIT, (raw) => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        if (!data || typeof data !== 'object') { try { res.destroy(); } catch {} return; }
        opts.permissions.add(res, {
          toolName: typeof data.tool_name === 'string' ? data.tool_name : 'Unknown',
          toolInput: data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {},
          sessionId: typeof data.session_id === 'string' ? data.session_id : 'unknown',
          cwd: typeof data.cwd === 'string' ? data.cwd : null,
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tryListen = (i) => {
    if (i >= T.PORTS.length) return cb(new Error('remi-pet: 端口段全被占用'), null);
    const port = T.PORTS[i];
    // error 和 listening 必须成对清理,否则失败那次的 listening 回调会残留,
    // 换端口成功时带着旧端口再触发一次 cb
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') tryListen(i + 1);
      else cb(err, null);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      T.writeRuntimePort(port);
      cb(null, { server, port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  };
  tryListen(0);
  return server;
}

module.exports = { startServer };
