import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTree } from '../benchmark/tree-baseline/tree.mjs';
import { report } from '../benchmark/run.mjs';

test('tree baseline lists files without ranking and respects the budget', () => {
  const paths = ['lib/auth.ts', 'lib/prisma.ts', 'app/page.tsx', 'README.md'].sort();
  const full = renderTree(paths, 1000);
  assert.match(full, /# File tree: 4 source files/);
  assert.match(full, /^lib\/\n {2}auth\.ts\n {2}prisma\.ts$/m);
  assert.doesNotMatch(full, /used by|L\d/);
  const cut = renderTree(paths, 20);
  assert.match(cut, /more files not shown/);
});

test('report leads with task success and splits tokens by question type', () => {
  const questions = [{ id: 'a', type: 'lookup' }, { id: 'b', type: 'topology' }];
  const run = (id, condition, totalTokens, correct = true) => ({ id, condition, totalTokens, correct, error: null });
  const runs = [
    run('a', 'none', 100), run('a', 'none', 120), run('a', 'armap', 110), run('a', 'armap', 130, false),
    run('b', 'none', 200), run('b', 'none', 220), run('b', 'armap', 100),
    { id: 'b', condition: 'armap', error: 'timeout', correct: false },
  ];
  const text = report({ questions, runs, conditions: ['none', 'armap'], trials: 2, model: 'test' });
  assert.ok(text.indexOf('## Task success') < text.indexOf('## Tokens'));
  assert.match(text, /\| lookup \| 1 \| 2\/2 \| 1\/2 \|/);
  assert.match(text, /\| topology \| 1 \| 2\/2 \| 1\/2 \|/);
  assert.match(text, /\| lookup \| 110 \| 120 \| \+9% \|/);
  assert.match(text, /\| topology \| 210 \| 100 \| -52% \|/);
  assert.match(text, /failed runs: 1/);
  assert.match(text, /too few to trust/);
});
