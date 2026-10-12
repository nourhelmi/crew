/** Client-supplied MCP configuration stays in private session metadata and native
 * protocol frames, never public session projections, command arguments or env. */
export type McpServer =
  | { name: string; type?: 'stdio'; command: string; args: string[]; env: { name: string; value: string }[] }
  | { name: string; type: 'http'; url: string; headers: { name: string; value: string }[] };

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('crew: invalid MCP server configuration');
  return value as Record<string, unknown>;
};
const string = (value: unknown, max = 16_384): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('crew: invalid MCP configuration value');
  return value;
};
const pairs = (value: unknown, headers = false): { name: string; value: string }[] => {
  if (!Array.isArray(value) || value.length > 128) throw new Error('crew: invalid MCP configuration entries');
  const seen = new Set<string>();
  return value.map(item => {
    const entry = object(item), name = string(entry.name, 256), text = string(entry.value);
    const key = headers ? name.toLowerCase() : name;
    if (!name || seen.has(key) || (headers ? /[\r\n]/.test(name + text) : name.includes('='))) throw new Error('crew: invalid MCP configuration entry');
    seen.add(key);
    return { name, value: text };
  });
};

export function validateMcpServers(value: unknown): McpServer[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('crew: expected at most 32 MCP servers');
  const seen = new Set<string>();
  return value.map(item => {
    const server = object(item), name = string(server.name, 128);
    if (!name.trim() || seen.has(name)) throw new Error('crew: MCP server names must be nonempty and unique');
    seen.add(name);
    if (server.type === 'http') {
      const url = string(server.url, 16_384);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('crew: invalid MCP server URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('crew: MCP server URL must use HTTP or HTTPS');
      return { name, type: 'http' as const, url, headers: pairs(server.headers ?? [], true) };
    }
    if (server.type !== undefined && server.type !== 'stdio') throw new Error('crew: MCP transport is unsupported; use stdio or HTTP');
    const command = string(server.command, 4096);
    if (!command.trim() || !Array.isArray(server.args) || server.args.length > 256) throw new Error('crew: invalid MCP stdio command');
    return { name, command, args: server.args.map(arg => string(arg)), env: pairs(server.env ?? []) };
  });
}

export function codexMcpServers(servers: McpServer[]): Record<string, unknown> {
  return Object.fromEntries(servers.map(server => [server.name, server.type === 'http'
    ? { url: server.url, http_headers: Object.fromEntries(server.headers.map(entry => [entry.name, entry.value])) }
    : { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) }]));
}

export function claudeMcpServers(servers: McpServer[]): Record<string, unknown> {
  return Object.fromEntries(servers.map(server => [server.name, server.type === 'http'
    ? { type: 'http', url: server.url, headers: Object.fromEntries(server.headers.map(entry => [entry.name, entry.value])) }
    : { type: 'stdio', command: server.command, args: server.args, env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) }]));
}
