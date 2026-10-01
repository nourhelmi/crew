// Isolated app-server protocol fixture. Never uses host state or a real Codex executable.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const [socket, scenarioFile, eventsFile] = process.argv.slice(2) as [string, string, string];
const server = createServer();
const frame = (data: string): Buffer => {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4); header[0] = 0x81;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
};
server.on('upgrade', (req, stream) => {
  const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  stream.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let raw = Buffer.alloc(0);
  stream.on('error', () => {});
  stream.on('data', chunk => {
    raw = Buffer.concat([raw, chunk]);
    while (raw.length >= 2) {
      const opcode = raw[0]! & 15;
      let length = raw[1]! & 127, offset = 2;
      if (length === 126) { if (raw.length < 4) return; length = raw.readUInt16BE(2); offset = 4; }
      if (length === 127) throw new Error('fixture frame too large');
      const masked = Boolean(raw[1]! & 128);
      if (raw.length < offset + (masked ? 4 : 0) + length) return;
      const mask = raw.subarray(offset, offset + 4); if (masked) offset += 4;
      const data = Buffer.from(raw.subarray(offset, offset + length)); raw = raw.subarray(offset + length);
      if (masked) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
      if (opcode === 8) { stream.end(Buffer.from([0x88, 0])); return; }
      if (opcode !== 1) continue;
      const request = JSON.parse(data.toString());
      appendFileSync(eventsFile, JSON.stringify(request) + '\n');
      if (!request.id) continue;
      const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
      let result: unknown = {};
      if (request.method === 'thread/loaded/list') result = scenario.unloaded ? { data: [], nextCursor: null }
        : scenario.paginated && !request.params.cursor ? { data: ['other'], nextCursor: 'page2' } : { data: [scenario.threadId], nextCursor: null };
      if (request.method === 'thread/read') {
        result = { thread: { id: scenario.wrongId ? 'other' : scenario.threadId, status: { type: scenario.status ?? 'active' }, canAcceptDirectInput: scenario.direct !== false } };
        if (scenario.consume) writeFileSync(join(scenario.mailDir, 'cursor'), String(Buffer.byteLength(readFileSync(join(scenario.mailDir, 'inbox.jsonl')))));
      }
      if (request.method === 'thread/turns/list') result = { data: [{ id: 'turn-current', status: scenario.turnStatus ?? 'inProgress' }] };
      if (request.method.startsWith('turn/')) {
        if (scenario.disconnect) { stream.destroy(); continue; }
        if (scenario.timeout) continue;
        if (scenario.reject) { stream.write(frame(JSON.stringify({ id: request.id, error: { code: -32600, message: 'active turn changed' } }))); continue; }
        result = request.method === 'turn/steer' ? { turnId: 'turn-current' } : { turn: { id: 'new-turn' } };
      }
      // A notification interleaved with a split response exercises native frame buffering.
      const response = frame(JSON.stringify({ id: request.id, result }));
      stream.write(frame('{"method":"test/notification","params":{}}'));
      stream.write(response.subarray(0, 3)); stream.write(response.subarray(3));
    }
  });
});
server.listen(socket, () => console.log('ready'));
