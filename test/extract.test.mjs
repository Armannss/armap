import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract } from '../src/extract.mjs';
import { importSpecs } from '../src/imports.mjs';

const names = (text, lang) => extract(text, lang).defs.map((d) => `${d.name}:${d.line}`);
const fill = (line) => line.repeat(Math.ceil((256 * 1024) / line.length));
const seconds = (fn) => { const t = performance.now(); fn(); return (performance.now() - t) / 1000; };

test('c and java: function definitions whose arguments span several lines', () => {
  const c = 'static int\nlist_len(void);\n\nint list_find(struct list *l,\n              const char *key,\n              int flags)\n{\n  return 0;\n}\n';
  assert.deepEqual(names(c, 'c'), ['list_find:4']);
  const java = 'public class Repo {\n  public static List<String> build(\n      String name,\n      int count) throws IOException {\n    return null;\n  }\n}\n';
  assert.deepEqual(names(java, 'java'), ['Repo:1', 'build:2']);
});

// Each of these once made every line scan to the end of the file: seconds per 256 KB file.
for (const [label, run] of [
  ['c function arguments with no ;{}', () => extract(fill('a b c d e f g h (x\n'), 'c')],
  ['pub( modifier with no closing paren', () => extract(fill('pub(\n'), 'javascript')],
  ['rust pub( use with no closing paren', () => importSpecs(fill('pub(\n'), 'rust')],
  ['python relative import with a long run of dots', () => importSpecs(fill(`from ${'.'.repeat(10000)}x\n`), 'python')],
]) {
  test(`regexes stay linear on a 256 KB file: ${label}`, () => {
    const s = seconds(run);
    assert.ok(s < 0.5, `took ${s.toFixed(2)}s`);
  });
}
