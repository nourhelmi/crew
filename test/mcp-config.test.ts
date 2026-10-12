import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMcpServers } from '../src/mcp-config.ts';

test('client MCP config rejects duplicate identities and malformed transport without echoing credentials', () => {
  const http = { name: 'one', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'Authorization', value: 'private-fixture' }] };
  assert.deepEqual(validateMcpServers([http]), [http]);
  for (const input of [[http, http], [{ ...http, url: 'file:///private-fixture' }], [{ ...http, headers: [{ name: 'Authorization', value: 'private-fixture\nInjected: yes' }] }], [{ ...http, type: 'sse' }]]) {
    assert.throws(() => validateMcpServers(input), error => error instanceof Error && !error.message.includes('private-fixture'));
  }
});

test('client MCP config returns copied bounded stdio definitions', () => {
  const source = [{ name: 'stdio', command: '/fixture/server', args: ['--stdio'], env: [{ name: 'KEY', value: 'value' }] }];
  const result = validateMcpServers(source);
  source[0]!.args.push('changed'); source[0]!.env[0]!.value = 'changed';
  assert.equal(result[0]?.type, undefined);
  assert.deepEqual(result, [{ name: 'stdio', command: '/fixture/server', args: ['--stdio'], env: [{ name: 'KEY', value: 'value' }] }]);
});
