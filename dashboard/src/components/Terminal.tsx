import { useEffect, useRef } from 'react';
import { terminalWsUrl } from '../api';

// Interactive terminal (#71): an xterm.js terminal wired to the server's exec
// WebSocket (proxied by the orchestrator to the owning Node Agent). xterm is
// imported dynamically inside the effect so it never loads in unit tests or
// bloats the initial bundle — it's only pulled when a terminal is actually shown.
export function Terminal({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !ref.current) return;

      const term = new Xterm({ convertEol: true, cursorBlink: true, fontSize: 13, fontFamily: 'var(--font-mono, ui-monospace, monospace)', theme: { background: '#0b0f19' } });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();

      const ws = new WebSocket(terminalWsUrl(id, term.cols, term.rows));
      ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
      ws.onopen = () => term.focus();
      ws.onclose = () => term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n');
      ws.onerror = () => term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');

      const input = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
      const onResize = () => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      window.addEventListener('resize', onResize);

      cleanup = () => {
        window.removeEventListener('resize', onResize);
        input.dispose();
        ws.close();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [id]);

  return <div ref={ref} style={{ height: 380, width: '100%', background: '#0b0f19', borderRadius: 8, padding: 8, overflow: 'hidden' }} />;
}
