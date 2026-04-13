// server.js
// Полноценный прокси-сервер через WebSocket для Render.com
// Поддерживает HTTP и HTTPS (CONNECT) запросы

const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const url = require('url');
const net = require('net');

// Создаём обычный HTTP-сервер для отдачи статики и ответа на проверки
const server = http.createServer((req, res) => {
  // Можно добавить отдачу клиентского скрипта или просто отвечать OK
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Tunnel server is running');
});

// WebSocket-сервер на том же HTTP-сервере
const wss = new WebSocket.Server({ server });

// Хранилище активных WebSocket-соединений (только метаданные, без логов трафика)
const clients = new Map(); // ключ: ws, значение: { createdAt, requestsCount }

// Периодическая очистка старых соединений (раз в час, если висят больше суток)
setInterval(() => {
  const now = Date.now();
  for (const [ws, info] of clients.entries()) {
    if (now - info.createdAt > 24 * 60 * 60 * 1000) {
      ws.terminate();
      clients.delete(ws);
    }
  }
}, 60 * 60 * 1000);

// Обработка нового WebSocket-соединения
wss.on('connection', (ws, req) => {
  const clientId = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  console.log(`[${clientId}] WebSocket connected`);

  // Сохраняем информацию о клиенте
  clients.set(ws, {
    createdAt: Date.now(),
    clientId: clientId,
    requestsCount: 0
  });

  // Обработка входящих сообщений от клиента
  ws.on('message', (message) => {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;

    try {
      const data = JSON.parse(message);
      const { requestId, type } = data;

      // Увеличиваем счётчик запросов (только статистика)
      clientInfo.requestsCount++;

      if (type === 'http') {
        // Обычный HTTP-запрос
        handleHttpRequest(ws, requestId, data);
      } else if (type === 'connect') {
        // CONNECT-туннель для HTTPS
        handleConnectRequest(ws, requestId, data);
      } else {
        // Неизвестный тип запроса
        ws.send(JSON.stringify({
          requestId,
          error: 'Unsupported request type'
        }));
      }
    } catch (err) {
      console.error(`[${clientId}] Invalid message:`, err.message);
      // Отправляем ошибку, если requestId был в сообщении
      try {
        const parsed = JSON.parse(message);
        if (parsed.requestId) {
          ws.send(JSON.stringify({
            requestId: parsed.requestId,
            error: 'Invalid message format'
          }));
        }
      } catch (e) {
        // Игнорируем, если сообщение не JSON
      }
    }
  });

  // При закрытии соединения удаляем информацию о клиенте
  ws.on('close', () => {
    const info = clients.get(ws);
    console.log(`[${info?.clientId || 'unknown'}] WebSocket disconnected`);
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`[${clientId}] WebSocket error:`, err.message);
  });
});

/**
 * Обработка обычного HTTP-запроса
 * @param {WebSocket} ws - WebSocket-соединение клиента
 * @param {number} requestId - Идентификатор запроса
 * @param {object} data - Данные запроса
 */
function handleHttpRequest(ws, requestId, data) {
  const { method, url: targetUrl, headers, body } = data;

  // Парсим URL
  const parsedUrl = url.parse(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.path,
    method: method,
    headers: headers || {}
  };

  // Удаляем hop-by-hop заголовки, которые не должны передаваться прокси
  delete options.headers['connection'];
  delete options.headers['keep-alive'];
  delete options.headers['proxy-connection'];
  delete options.headers['transfer-encoding'];
  delete options.headers['upgrade'];

  // Создаём запрос к целевому серверу
  const proxyReq = httpModule.request(options, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const responseBody = Buffer.concat(chunks);
      
      // Отправляем ответ клиенту через WebSocket
      ws.send(JSON.stringify({
        requestId: requestId,
        type: 'response',
        statusCode: proxyRes.statusCode,
        headers: proxyRes.headers,
        body: responseBody.toString('base64') // бинарные данные кодируем в base64
      }));
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[request ${requestId}] Proxy error:`, err.message);
    ws.send(JSON.stringify({
      requestId: requestId,
      type: 'error',
      error: err.message
    }));
  });

  // Если есть тело запроса, отправляем его
  if (body) {
    proxyReq.write(Buffer.from(body, 'base64'));
  }
  proxyReq.end();
}

/**
 * Обработка CONNECT-туннеля для HTTPS
 * @param {WebSocket} ws - WebSocket-соединение клиента
 * @param {number} requestId - Идентификатор запроса
 * @param {object} data - Данные запроса (содержит host и port)
 */
function handleConnectRequest(ws, requestId, data) {
  const { host, port } = data;

  // Создаём TCP-соединение с целевым сервером
  const targetSocket = net.createConnection({ host, port: parseInt(port) || 443 }, () => {
    // Отправляем подтверждение клиенту
    ws.send(JSON.stringify({
      requestId: requestId,
      type: 'connected',
      statusCode: 200
    }));

    // Теперь мы должны пробрасывать данные между WebSocket и targetSocket
    // Для этого создаём отдельный канал связи внутри WebSocket
    setupBidirectionalTunnel(ws, targetSocket, requestId);
  });

  targetSocket.on('error', (err) => {
    console.error(`[CONNECT ${requestId}] Target socket error:`, err.message);
    ws.send(JSON.stringify({
      requestId: requestId,
      type: 'error',
      error: err.message
    }));
  });

  // Если соединение не установилось за 10 секунд, считаем ошибкой
  targetSocket.setTimeout(10000, () => {
    targetSocket.destroy();
    ws.send(JSON.stringify({
      requestId: requestId,
      type: 'error',
      error: 'Connection timeout'
    }));
  });
}

/**
 * Настройка двустороннего проброса данных между WebSocket и TCP-сокетом
 * @param {WebSocket} ws - WebSocket клиента
 * @param {net.Socket} targetSocket - Сокет к целевому серверу
 * @param {number} tunnelId - Идентификатор туннеля (requestId)
 */
function setupBidirectionalTunnel(ws, targetSocket, tunnelId) {
  // Флаг для предотвращения множественных закрытий
  let closed = false;

  // Функция очистки
  const cleanup = () => {
    if (closed) return;
    closed = true;
    targetSocket.destroy();
    // Отправляем уведомление о закрытии туннеля
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tunnel-closed',
        tunnelId: tunnelId
      }));
    }
  };

  // Данные от целевого сервера -> WebSocket клиенту
  targetSocket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tunnel-data',
        tunnelId: tunnelId,
        data: data.toString('base64')
      }));
    }
  });

  targetSocket.on('end', cleanup);
  targetSocket.on('close', cleanup);
  targetSocket.on('error', (err) => {
    console.error(`[Tunnel ${tunnelId}] Socket error:`, err.message);
    cleanup();
  });

  // Данные от клиента через WebSocket -> целевому серверу
  // Мы должны перехватывать сообщения определённого формата
  const messageHandler = (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'tunnel-data' && msg.tunnelId === tunnelId) {
        const dataBuffer = Buffer.from(msg.data, 'base64');
        targetSocket.write(dataBuffer);
      } else if (msg.type === 'tunnel-close' && msg.tunnelId === tunnelId) {
        cleanup();
      }
    } catch (e) {
      // Игнорируем не-JSON сообщения или ошибки парсинга
    }
  };

  // Временно добавляем обработчик для этого туннеля
  ws.on('message', messageHandler);

  // Когда WebSocket закрывается, убираем обработчик и чистим
  ws.once('close', () => {
    cleanup();
    ws.removeListener('message', messageHandler);
  });

  // Если туннель закрывается, убираем обработчик
  targetSocket.once('close', () => {
    ws.removeListener('message', messageHandler);
  });
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebSocket tunnel server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT} (or wss://your-domain.onrender.com)`);
});