import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { DashboardObserver } from './dashboard-observe.ts';
import { ConsoleController } from './console-controller.ts';
import { ConsoleError } from './console-store.ts';

const assets = new Map([
  ['/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.html', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/stream-format.js', ['stream-format.js', 'text/javascript; charset=utf-8']],
]);

export function createDashboardServer(observer = new DashboardObserver(), intervalMs = 1_000, controller?: ConsoleController): Server {
  const streams = new Set<() => void>();
  const server = createServer(async (req, res) => {
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
    const url = new URL(req.url ?? '/', origin);
    if (req.method !== 'GET') {
      if (req.method !== 'POST' || !controller || !url.pathname.startsWith('/api/console/')) {
        res.setHeader('Allow', 'GET'); json(405, { error: 'This endpoint is read-only.' }); return;
      }
      if (req.headers.origin !== origin || req.headers['x-crew-token'] !== controller.token) {
        json(403, { error: 'Console mutations require the current same-origin capability.', code: 'FORBIDDEN' }); return;
      }
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        json(415, { error: 'Send application/json.', code: 'INVALID_INPUT' }); return;
      }
      const match = url.pathname.match(/^\/api\/console\/sessions(?:\/([A-Za-z0-9_-]{1,128})\/(messages|actions|answers))?$/);
      const childMatch = url.pathname.match(/^\/api\/console\/sessions\/([A-Za-z0-9_-]{1,128})\/children\/([A-Za-z0-9_-]{1,100})\/(actions|answers)$/);
      if (!match && !childMatch) { json(404, { error: 'Not found', code: 'NOT_FOUND' }); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 65_536) { json(413, { error: 'Request body is too large.', code: 'BODY_LIMIT' }); return; }
          chunks.push(Buffer.from(chunk));
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ConsoleError('Send a valid JSON object.'); }
        const id = match?.[1]; const operation = match?.[2];
        const result = childMatch ? childMatch[3] === 'actions' ? await controller.childAction(childMatch[1]!, childMatch[2]!, body) : await controller.childAnswer(childMatch[1]!, childMatch[2]!, body)
          : !id ? await controller.launch(body) : operation === 'messages' ? await controller.message(id, body)
          : operation === 'actions' ? await controller.action(id, body) : await controller.answer(id, body);
        json(200, result);
      } catch (error) {
        if (error instanceof ConsoleError) json(error.status, { error: error.message, code: error.code });
        else json(500, { error: 'Console operation failed. Inspect the owned session state before retrying.', code: 'OPERATION_FAILED' });
      }
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset) {
      try {
        const body = readFileSync(new URL(`../web/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1]! }); res.end(body);
      } catch { json(500, { error: 'Dashboard assets could not be read.' }); }
      return;
    }
    try {
      if (url.pathname === '/api/console') {
        if (!controller) { json(404, { error: 'Console controls are unavailable.' }); return; }
        json(200, controller.bootstrap()); return;
      }
      const managed = url.pathname.match(/^\/api\/console\/sessions\/([A-Za-z0-9_-]{1,128})$/);
      if (managed) {
        const detail = controller?.detail(managed[1]!, url.searchParams.get('before') ?? undefined);
        json(detail ? 200 : 404, detail ?? { error: 'Managed session is unavailable.', code: 'SESSION_NOT_FOUND' }); return;
      }
      const team = url.pathname.match(/^\/api\/console\/sessions\/([A-Za-z0-9_-]{1,128})\/team$/);
      const child = url.pathname.match(/^\/api\/console\/sessions\/([A-Za-z0-9_-]{1,128})\/children\/([A-Za-z0-9_-]{1,100})$/);
      if (team || child) {
        const value = team ? controller?.team(team[1]!) : controller?.childDetail(child![1]!, child![2]!, url.searchParams.get('before') ?? undefined);
        json(value ? 200 : 404, value ?? { error: 'Managed team or child is unavailable.', code: 'CHILD_NOT_FOUND' }); return;
      }
      if (url.pathname === '/api/snapshot') { json(200, observer.snapshot()); return; }
      if (url.pathname === '/api/detail') {
        observer.snapshot();
        const detail = observer.detail(url.searchParams.get('node') ?? '');
        json(detail ? 200 : 404, detail ?? { error: 'This run is no longer available.' }); return;
      }
      if (url.pathname !== '/api/events') { json(404, { error: 'Not found' }); return; }
      const selected = url.searchParams.get('node');
      const selectedSession = url.searchParams.get('session');
      const selectedRun = url.searchParams.get('run');
      if (selectedSession && !controller?.detail(selectedSession)) { json(404, { error: 'Managed session is unavailable.', code: 'SESSION_NOT_FOUND' }); return; }
      if (selectedRun && (!selectedSession || !controller?.childDetail(selectedSession, selectedRun))) { json(404, { error: 'Managed child is unavailable.', code: 'CHILD_NOT_FOUND' }); return; }
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
          const data = JSON.stringify({ snapshot, detail, ...(controller ? { console: controller.update(selectedSession ?? undefined, selectedRun ?? undefined) } : {}) });
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
    } catch (error) {
      if (error instanceof ConsoleError) json(error.status, { error: error.message, code: error.code });
      else json(500, { error: 'Run data could not be read. Check CREW_HOME and host transcript permissions.' });
    }
  });
  // Close active EventSource connections as well as the listening socket.
  const close = server.close.bind(server);
  server.close = callback => { for (const stop of [...streams]) stop(); return close(callback); };
  return server;
}

export async function dashboard(port = 4317): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('crew: --port must be an integer from 0 to 65535');
  const server = createDashboardServer(new DashboardObserver(), 1_000, new ConsoleController());
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('crew: dashboard did not bind a local port');
  console.log(`crew console: http://127.0.0.1:${address.port}\nLaunch and control console-owned roots; existing external roots are view-only. Ctrl+C stops the web listener; owned roots continue.`);
  const stop = (): void => { server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
}
