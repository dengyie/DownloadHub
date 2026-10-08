import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from '../build.mjs';

// Build evidence is kept in a private test directory, never over a source tree.
test('builds are deterministic, self-contained and exclude fixtures/backend sources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cardgw-static-build-'));
  const first = await build(path.join(directory, 'first'));
  const second = await build(path.join(directory, 'second'));
  assert.equal(first.version, second.version);
  assert.match(first.version, /^[a-f0-9]{24}$/);
  const manifest = JSON.parse(await readFile(path.join(first.output, 'build.json'), 'utf8'));
  assert.equal(manifest.version, first.version);
  assert.equal(manifest.assets.length, first.files);
  assert.deepEqual(
    await readFile(path.join(first.output, 'ui/captcha.js')),
    await readFile(path.join(first.output, 'ui', first.version, 'captcha.js'))
  );
  assert.deepEqual((await readdir(first.output)).sort(), ['brand', 'build.json', 'index.html', 'ui']);
  const html = await readFile(path.join(first.output, 'index.html'), 'utf8');
  assert.ok(html.includes(`/ui/${first.version}/app.js`));
  assert.ok(!/__RELEASE__|data-fixture|data-readonly/.test(html));
  for (const asset of manifest.assets) {
    assert.match(asset, new RegExp(`^/ui/${first.version}/[A-Za-z0-9_/-]+\\.(?:js|css)$`));
    assert.ok(!/fixture|tests|node_modules|config\.yaml/.test(asset));
    assert.deepEqual(
      await readFile(path.join(first.output, asset)),
      await readFile(path.join(second.output, asset))
    );
  }
  const previous = path.join(first.output, 'ui', '0'.repeat(24));
  await mkdir(previous);
  await writeFile(path.join(previous, 'old.js'), 'previous release');
  await build(first.output);
  assert.equal(await readFile(path.join(previous, 'old.js'), 'utf8'), 'previous release');
});

test('a symlink output is rejected before overwriting a different destination', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cardgw-build-safety-'));
  const destination = path.join(directory, 'unrelated');
  await mkdir(destination);
  await writeFile(path.join(destination, 'index.html'), 'keep this content');
  const output = path.join(directory, 'output');
  await symlink(destination, output, 'dir');
  await assert.rejects(build(output), /output.*symlink/i);
  assert.equal(await readFile(path.join(destination, 'index.html'), 'utf8'), 'keep this content');
});
