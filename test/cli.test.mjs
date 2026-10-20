import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../bin/armap.mjs', import.meta.url));

for (const populated of [false, true]) {
  test(`CLI validates commands and required arguments (${populated ? 'source files' : 'empty directory'})`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'armap-cli-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (populated) writeFileSync(join(root, 'sample.js'), 'export const example = 1;\n');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
    for (const [command, error] of [
      ['typo', /Unknown command "typo"/],
      ['deps', /deps needs a file path/],
      ['refs', /refs needs a symbol name/],
    ]) {
      const result = run(command);
      assert.equal(result.status, 1, `${command} must fail`);
      assert.match(result.stderr, error);
      assert.equal(result.stdout, '');
      const hook = run(command, '--hook');
      assert.equal(hook.status, 0);
      assert.equal(hook.stdout, '');
      assert.equal(hook.stderr, '');
    }
    const valid = run('map');
    assert.equal(valid.status, 0);
    assert.equal(valid.stderr, '');
    assert.match(valid.stdout, populated ? /sample\.js/ : /No source files found/);
    assert.equal(run('--help').status, 0);
  });
}
