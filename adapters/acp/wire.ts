import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { AcpError } from './store.ts';

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AcpError('Expected an object.');
  return value as JsonObject;
};
export const optionalObject = (value: unknown): JsonObject => value === undefined || value === null ? {} : object(value);
export const text = (value: unknown, name: string, max = 24_000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new AcpError(`Invalid ${name}.`);
  return value;
};
export const safeId = (value: unknown): string => {
  const id = text(value, 'requestId', 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AcpError('Invalid requestId.');
  return id;
};
export function promptText(value: unknown): string {
  if (!Array.isArray(value) || !value.length) throw new AcpError('Prompt requires content blocks.');
  return text(value.map(block => {
    const content = object(block);
    if (content.type === 'text') return text(content.text, 'text');
    if (content.type === 'resource_link') return `${text(content.name, 'resource name', 256)}: ${text(content.uri, 'resource URI', 4096)}`;
    throw new AcpError('This adapter supports text and resource links, not images, audio or embedded resources.');
  }).join('\n'), 'prompt');
}
export type RpcId = string | number;
export class AcpWire {
  private pending = new Map<RpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
  private sequence = 0;
  private closed = false;
  constructor(privateOutput: Writable) { this.output = privateOutput; }
  readonly output: Writable;
  send(value: unknown): void {
    if (!this.closed) this.output.write(`${JSON.stringify(value)}\n`);
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpError('ACP connection closed.', -32000));
    const id = `crew-request-${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return result;
  }
  response(message: JsonObject): boolean {
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    if ('error' in message) pending.reject(new AcpError('Client declined or could not handle the request.', -32000));
    else pending.resolve(message.result);
    return true;
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new AcpError('ACP connection closed.', -32000));
    this.pending.clear();
  }
}
/** JSONL with bounded partial frames; stdio never mixes diagnostics into JSON. */
export async function* readMessages(input: Readable): AsyncGenerator<unknown> {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  for await (const chunk of input) {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      if (newline > 1024 * 1024) throw new AcpError('ACP frame exceeds 1 MiB.', -32600);
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { yield null; }
    }
    if (buffered.length > 1024 * 1024) throw new AcpError('ACP frame exceeds 1 MiB.', -32600);
  }
  if ((buffered + decoder.end()).trim()) throw new AcpError('Incomplete ACP JSONL frame.', -32700);
}
