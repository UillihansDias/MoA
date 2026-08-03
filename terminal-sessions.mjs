import crypto from 'node:crypto';
import * as pty from 'node-pty';
import WebSocket, { WebSocketServer } from 'ws';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const MIN_COLS = 20;
const MAX_COLS = 300;
const MIN_ROWS = 8;
const MAX_ROWS = 120;
const MAX_SESSIONS = 4;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 512 * 1024;
const EXIT_RETENTION_MS = 30_000;

const terminalSize = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

const safeSend = (socket, message) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

export const createTerminalSessionManager = ({
  resolveCli,
  resolveArgs,
  cwd,
  env,
  originAllowed,
  disconnectGraceMs = 5_000,
}) => {
  const sessions = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });

  const terminate = (id, reason = 'closed') => {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    clearTimeout(session.disconnectTimer);
    clearTimeout(session.retentionTimer);
    if (!session.exited) {
      session.exited = true;
      try { session.process.kill('SIGTERM'); } catch { /* The process already exited. */ }
    }
    for (const socket of session.sockets) {
      safeSend(socket, { type: 'closed', reason });
      socket.close(1000, reason);
    }
    session.sockets.clear();
    return true;
  };

  const create = async ({ cliId, cols, rows }) => {
    if (sessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error('Close an existing terminal before opening another.'), { statusCode: 409 });
    }
    const cli = await resolveCli(cliId);
    if (!cli) throw Object.assign(new Error('CLI integration not found or unavailable.'), { statusCode: 404 });

    const dimensions = {
      cols: terminalSize(cols, DEFAULT_COLS, MIN_COLS, MAX_COLS),
      rows: terminalSize(rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS),
    };
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    let terminalProcess;
    try {
      terminalProcess = pty.spawn(cli.binary, await resolveArgs(cli), {
        name: 'xterm-256color',
        cols: dimensions.cols,
        rows: dimensions.rows,
        cwd,
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        encoding: 'utf8',
      });
    } catch (error) {
      throw Object.assign(new Error(`Unable to start ${cli.label}: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 500 });
    }

    const session = {
      id,
      token,
      cliId: cli.id,
      label: cli.label,
      process: terminalProcess,
      sockets: new Set(),
      output: '',
      exited: false,
      dimensions,
      disconnectTimer: null,
      retentionTimer: null,
    };
    sessions.set(id, session);

    terminalProcess.onData((data) => {
      session.output = `${session.output}${data}`.slice(-MAX_OUTPUT_CHARS);
      for (const socket of session.sockets) safeSend(socket, { type: 'output', data });
    });
    terminalProcess.onExit(({ exitCode, signal }) => {
      if (!sessions.has(id)) return;
      session.exited = true;
      const message = { type: 'exit', exitCode, signal };
      for (const socket of session.sockets) safeSend(socket, message);
      session.retentionTimer = setTimeout(() => terminate(id, 'expired'), EXIT_RETENTION_MS);
      session.retentionTimer.unref?.();
    });

    return {
      id,
      cliId: cli.id,
      label: cli.label,
      socketPath: `/api/terminal-sessions/${id}/socket?token=${encodeURIComponent(token)}`,
      cols: dimensions.cols,
      rows: dimensions.rows,
    };
  };

  websocketServer.on('connection', (socket, request, session) => {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
    session.sockets.add(socket);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    safeSend(socket, {
      type: 'ready',
      cliId: session.cliId,
      label: session.label,
      output: session.output,
      cols: session.dimensions.cols,
      rows: session.dimensions.rows,
      exited: session.exited,
    });

    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= MAX_INPUT_BYTES && !session.exited) {
        session.process.write(message.data);
        return;
      }
      if (message.type === 'resize' && !session.exited) {
        const next = {
          cols: terminalSize(message.cols, session.dimensions.cols, MIN_COLS, MAX_COLS),
          rows: terminalSize(message.rows, session.dimensions.rows, MIN_ROWS, MAX_ROWS),
        };
        if (next.cols === session.dimensions.cols && next.rows === session.dimensions.rows) return;
        session.dimensions = next;
        session.process.resize(next.cols, next.rows);
        safeSend(socket, { type: 'resized', ...next });
        return;
      }
      if (message.type === 'close') terminate(session.id, 'closed_by_user');
    });
    socket.on('close', () => {
      session.sockets.delete(socket);
      if (!sessions.has(session.id) || session.exited || session.sockets.size) return;
      session.disconnectTimer = setTimeout(() => terminate(session.id, 'disconnected'), disconnectGraceMs);
      session.disconnectTimer.unref?.();
    });
    socket.on('error', () => { /* Close handling owns cleanup. */ });
  });

  const attach = (server) => {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const match = url.pathname.match(/^\/api\/terminal-sessions\/([0-9a-f-]+)\/socket$/);
      const session = match ? sessions.get(match[1]) : null;
      if (!session || url.searchParams.get('token') !== session.token || !originAllowed(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, request, session);
      });
    });
  };

  const heartbeat = setInterval(() => {
    for (const socket of websocketServer.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  const dispose = () => {
    clearInterval(heartbeat);
    for (const id of [...sessions.keys()]) terminate(id, 'server_shutdown');
    websocketServer.close();
  };

  return { attach, create, terminate, dispose, size: () => sessions.size };
};
