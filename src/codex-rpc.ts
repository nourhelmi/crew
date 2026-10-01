import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { isAbsolute } from 'node:path';

export type Rpc = <T>(method: string, params: object) => Promise<T>;
export class RpcRejected extends Error {}

/** Node's native WebSocket handles framing; a one-use, nonce-protected loopback bridge
 * carries it to the Unix socket. No runtime dependency or permanent TCP listener. */
export async function connectCodex(socketPath: string): Promise<{ rpc: Rpc; close: () => void }> {
  if (!isAbsolute(socketPath)) throw new Error('crew: app-server socket must be absolute');
  const nonce = '/' + randomBytes(24).toString('hex');
  const sockets = new Set<Duplex>();
  let used = false;
  const bridge = createServer((_req, res) => { res.writeHead(403); res.end(); });
  bridge.on('upgrade', (req, front, head) => {
    if (used || req.url !== nonce || req.headers.origin || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      front.destroy(); return;
    }
    used = true;
    bridge.close();
    const back = createConnection(socketPath);
    sockets.add(front); sockets.add(back);
    for (const socket of [front, back]) {
      socket.on('error', () => { front.destroy(); back.destroy(); });
      socket.on('close', () => { sockets.delete(socket); front.destroy(); back.destroy(); });
    }
    back.once('connect', () => {
      back.write('GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n\r\n`);
      if (head.length) back.write(head);
      front.pipe(back).pipe(front);
    });
  });
  await new Promise<void>((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
  const port = (bridge.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${nonce}`);
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let id = 0;
  const failPending = () => {
    for (const request of pending.values()) request.reject(new Error('crew: app-server disconnected'));
    pending.clear();
  };
  ws.onmessage = event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return; // notifications and requests for the owning desktop client
    pending.delete(message.id);
    if (message.error) request.reject(new RpcRejected(String(message.error.message ?? 'app-server rejected request')));
    else request.resolve(message.result);
  };
  ws.onclose = failPending;
  const close = () => {
    failPending();
    ws.onerror = () => {};
    try { ws.close(); } catch { /* not connected */ }
    for (const socket of sockets) socket.destroy();
    bridge.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('crew: app-server connect timeout')), 2000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('crew: app-server connect failed')); };
    });
    ws.onerror = failPending;
    const rpc: Rpc = async <T>(method: string, params: object): Promise<T> => {
      const requestId = ++id;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          pending.set(requestId, { resolve: result => resolve(result as T), reject });
          timer = setTimeout(() => { pending.delete(requestId); reject(new Error('crew: app-server RPC timeout')); }, 2000);
          ws.send(JSON.stringify({ id: requestId, method, params }));
        });
      } finally { clearTimeout(timer); pending.delete(requestId); }
    };
    await rpc('initialize', { clientInfo: { name: 'crew', title: 'Crew mail', version: '0.12.0' }, capabilities: { experimentalApi: true } });
    ws.send('{"method":"initialized"}');
    return { rpc, close };
  } catch (error) { close(); throw error; }
}
