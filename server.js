// client-http.js
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');

const WS_URL = 'wss://vpn123.onrender.com'; // твой URL
const PROXY_PORT = 8080;

let ws = null;
let reqId = 0;
const pending = new Map();

function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.on('open', () => console.log('[WS] Connected'));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const resolver = pending.get(msg.requestId);
      if (!resolver) return;
      pending.delete(msg.requestId);

      if (msg.error) {
        resolver.res.writeHead(500, { 'Content-Type': 'text/plain' });
        resolver.res.end('Proxy error: ' + msg.error);
      } else {
        resolver.res.writeHead(msg.statusCode, msg.headers);
        resolver.res.end(Buffer.from(msg.body, 'base64'));
      }
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  });
  ws.on('close', () => {
    console.log('[WS] Disconnected, reconnecting...');
    setTimeout(connectWS, 3000);
  });
  ws.on('error', (err) => console.error('[WS] Error:', err));
}

const proxyServer = http.createServer((clientReq, clientRes) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
    clientRes.end('WebSocket not connected');
    return;
  }

  let bodyChunks = [];
  clientReq.on('data', chunk => bodyChunks.push(chunk));
  clientReq.on('end', () => {
    const bodyBuffer = Buffer.concat(bodyChunks);
    let fullUrl = clientReq.url;
    if (!fullUrl.startsWith('http')) {
      fullUrl = `http://${clientReq.headers.host}${clientReq.url}`;
    }

    const id = ++reqId;
    pending.set(id, { res: clientRes });

    const headers = { ...clientReq.headers };
    delete headers['proxy-connection'];

    ws.send(JSON.stringify({
      requestId: id,
      method: clientReq.method,
      url: fullUrl,
      headers: headers,
      body: bodyBuffer.length ? bodyBuffer.toString('base64') : null,
    }));
  });
});

proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[HTTP Proxy] Listening on 127.0.0.1:${PROXY_PORT}`);
});

connectWS();