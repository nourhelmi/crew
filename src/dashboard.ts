import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { DashboardObserver } from './dashboard-observe.ts';

const assets = new Map([
  ['/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);

export function createDashboardServer(observer = new DashboardObserver(), intervalMs = 1_000): Server {
  const streams = new Set<() => void>();
  const server = createServer((req, res) => {
    const address = server.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
    const host = origin.slice('http://'.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (code: number, value: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    // A local observer is not an API for arbitrary websites or DNS-rebinding hosts.
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      json(403, { error: 'Open the dashboard using its printed local URL.' }); return;
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(405, { error: 'This dashboard is read-only.' }); return; }
    const url = new URL(req.url ?? '/', origin);
    const asset = assets.get(url.pathname);
    if (asset) {
      try {
        const body = readFileSync(new URL(`../web/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1]! }); res.end(body);
      } catch { json(500, { error: 'Dashboard assets could not be read.' }); }
      return;
    }
    try {
      if (url.pathname === '/api/snapshot') { json(200, observer.snapshot()); return; }
      if (url.pathname === '/api/detail') {
        observer.snapshot();
        const detail = observer.detail(url.searchParams.get('node') ?? '');
        json(detail ? 200 : 404, detail ?? { error: 'This run is no longer available.' }); return;
      }
      if (url.pathname !== '/api/events') { json(404, { error: 'Not found' }); return; }
      const selected = url.searchParams.get('node');
      observer.snapshot();
      if (selected && !observer.detail(selected)) { json(404, { error: 'This run is no longer available.' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      let lastHash = '';
      let ticks = 0;
      const stop = (): void => { clearInterval(timer); streams.delete(stop); res.end(); };
      const update = (): void => {
        if (res.destroyed || res.writableEnded || res.writableNeedDrain) return;
        try {
          const snapshot = observer.snapshot();
          const detail = selected ? observer.detail(selected) ?? null : null;
          const data = JSON.stringify({ snapshot, detail });
          const hash = createHash('sha256').update(data).digest('hex');
          if (hash !== lastHash) {
            res.write(`event: update\ndata: ${data}\n\n`);
            lastHash = hash;
          } else if (++ticks % 15 === 0) res.write(': connected\n\n');
        } catch { res.write('event: unavailable\ndata: {"error":"Run data could not be refreshed. Retrying."}\n\n'); }
      };
      const timer = setInterval(update, intervalMs);
      timer.unref();
      streams.add(stop);
      res.on('close', stop);
      update();
    } catch { json(500, { error: 'Run data could not be read. Check CREW_HOME and host transcript permissions.' }); }
  });
  // Close active EventSource connections as well as the listening socket.
  const close = server.close.bind(server);
  server.close = callback => { for (const stop of [...streams]) stop(); return close(callback); };
  return server;
}

export async function dashboard(port = 4317): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('crew: --port must be an integer from 0 to 65535');
  const server = createDashboardServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('crew: dashboard did not bind a local port');
  console.log(`crew dashboard: http://127.0.0.1:${address.port}\nRead-only. Following Crew records and host output. Ctrl+C to stop.`);
  const stop = (): void => { server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
}
