import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDemo } from '../scripts/build-demo.mjs';

test('demo builds into valid JavaScript', () => {
  const html = buildDemo();
  const js = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!/^export /m.test(js), 'no ES module syntax left');
});

test('committed demo/portfolio-demo.html is up to date', () => {
  const committed = fs.readFileSync(new URL('../demo/portfolio-demo.html', import.meta.url), 'utf8');
  assert.equal(committed, buildDemo(), 'run "npm run build:demo" and commit the result');
});
