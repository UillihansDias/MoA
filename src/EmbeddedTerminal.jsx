import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const socketUrl = (path) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
};

export default function EmbeddedTerminal({ session, onClose, onError }) {
  const containerRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let resizeFrame = 0;
    let lastSize = '';
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      convertEol: false,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.22,
      letterSpacing: 0,
      scrollback: 10_000,
      theme: {
        background: '#050505',
        foreground: '#e7e7e7',
        cursor: '#b9b9b9',
        cursorAccent: '#050505',
        selectionBackground: '#3b3b3b',
        black: '#050505',
        brightBlack: '#696969',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const websocket = new WebSocket(socketUrl(session.socketPath));
    const send = (message) => {
      if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message));
    };
    const fit = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || !container.isConnected) return;
        try {
          fitAddon.fit();
          const size = `${terminal.cols}x${terminal.rows}`;
          if (size !== lastSize) {
            lastSize = size;
            send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
          }
        } catch { /* The container can be between layout states while unmounting. */ }
      });
    };

    const inputSubscription = terminal.onData((data) => send({ type: 'input', data }));
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    websocket.addEventListener('open', () => {
      if (disposed) return;
      setConnected(true);
      fit();
      terminal.focus();
    });
    websocket.addEventListener('message', ({ data }) => {
      if (disposed) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'ready') {
        if (message.output) terminal.write(message.output);
        fit();
      } else if (message.type === 'output' && typeof message.data === 'string') {
        terminal.write(message.data);
      } else if (message.type === 'exit') {
        terminal.writeln(`\r\n\x1b[90m[process exited${Number.isInteger(message.exitCode) ? ` with code ${message.exitCode}` : ''}]\x1b[0m`);
      }
    });
    websocket.addEventListener('close', () => {
      if (disposed) return;
      setConnected(false);
      onError('The embedded terminal session disconnected.');
    });
    websocket.addEventListener('error', () => {
      if (!disposed) onError('The embedded terminal connection could not be established.');
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      websocket.close();
      terminal.dispose();
    };
  }, [onError, session.socketPath]);

  return (
    <section className="embedded-terminal" aria-label={`${session.label} TUI`}>
      <button className="terminal-close" type="button" onClick={onClose} aria-label={`Close ${session.label} terminal`} title={`Close ${session.label} terminal`}>×</button>
      <div className="terminal-connection" data-connected={connected} aria-live="polite">{connected ? `${session.label} connected` : `Connecting to ${session.label}`}</div>
      <div ref={containerRef} className="terminal-canvas" role="application" aria-label={`${session.label} interactive terminal`} />
    </section>
  );
}
