import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProse, prettyOutput } from '../web/stream-format.js';

test('bounded prose supports readable structure and incomplete streaming fences', () => {
  const html = renderProse('# Outcome\n\nDone **today**, use `crew`.\n\n- one\n- two\n\n3. third\n\n| Claim | Proof |\n| --- | --- |\n| Passed | browser |\n\n```ts\nconst x = 1;');
  assert.match(html, /<h2>Outcome<\/h2>/);
  assert.match(html, /<strong>today<\/strong>/);
  assert.match(html, /<code>crew<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<th scope="col">Proof/);
  assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
  assert.match(renderProse('x'.repeat(100_001)), /Text shortened for display/);
});

test('source HTML, images, attributes, and unsafe or encoded URL schemes remain literal', () => {
  const html=renderProse('<script>evil()</script> <img src=x onerror=evil()>\n\n[x](javascript:evil) [x](data:text/html,evil) [x](jav&#x61;script:evil) [x](/local) ![image](https://example.com/a.png)');
  assert.doesNotMatch(html, /<(script|img|a)\b/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /!\[image\]/);
  const safe=renderProse('[Docs](https://example.com/?a="bad")');
  assert.match(safe, /href="https:\/\/example.com\/\?a=&quot;bad&quot;"/);
  assert.match(safe, /rel="noopener noreferrer"/);
});

test('tool output only pretty prints complete JSON and keeps arbitrary source literal', () => {
  assert.equal(prettyOutput('{"n":1}'), '{\n  "n": 1\n}');
  assert.equal(prettyOutput('{"n":'), '{"n":');
  assert.equal(prettyOutput('<script>'), '<script>');
  assert.match(prettyOutput('x'.repeat(100_001)), /Output shortened for display/);
});

test('malformed repeated delimiters stay literal without nested parsing', () => {
  const value='['.repeat(100_000);
  assert.equal(renderProse(value), '<p>'+value+'</p>');
});
