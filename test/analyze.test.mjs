import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { analyze } from '../src/analyze.mjs';
import { renderDeps, renderMap } from '../src/render.mjs';

function repo(tree) {
  const root = mkdtempSync(join(tmpdir(), 'armap-'));
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// { 'a.ts': ['b.ts', ...] } for every file that uses another.
function edges(root) {
  const { files, graph } = analyze(root);
  const result = {};
  files.forEach((f, i) => {
    const targets = [...graph.out[i].keys()].map((t) => files[t].path).sort();
    if (targets.length) result[f.path] = targets;
  });
  return result;
}

test('typescript: relative, alias and index imports; shared names without an import do not link', () => {
  const root = repo({
    'lib/data.ts': 'export const products = [];\n',
    'lib/auth/index.ts': 'export function getUser() {}\n',
    'lib/session.ts': 'export type SessionUser = {};\n',
    'context/Auth.tsx': 'type SessionUser = {};\nexport function useAuth() {}\n',
    'app/page.tsx': 'import { getUser } from "@/lib/auth";\nimport type { SessionUser } from "../lib/session";\nconst products = [1];\ngetUser();\n',
    'app/other.tsx': 'const products = []; // mentions products but imports nothing\n',
  });
  assert.deepEqual(edges(root), { 'app/page.tsx': ['lib/auth/index.ts', 'lib/session.ts'] });
});

test('javascript: require and bare package names', () => {
  const root = repo({
    'src/util.js': 'function helper() {}\nmodule.exports = { helper };\n',
    'src/path.js': 'function join() {}\n',
    'src/app.js': 'const { helper } = require("./util");\nconst path = require("path");\nhelper(); path.join();\n',
  });
  assert.deepEqual(edges(root), { 'src/app.js': ['src/util.js'] });
});

test('python: absolute, relative and package imports', () => {
  const root = repo({
    'app/__init__.py': '',
    'app/models.py': 'class User:\n    pass\n',
    'app/services/__init__.py': '',
    'app/services/billing.py': 'def charge():\n    pass\n',
    'app/views.py': 'from app.models import User\nfrom .services import billing\n\ndef show():\n    return User(), billing.charge()\n',
    'app/unrelated.py': 'User = "a string named User"\n',
  });
  // Importing from a package also loads its __init__.py.
  assert.deepEqual(edges(root)['app/views.py'], ['app/models.py', 'app/services/__init__.py', 'app/services/billing.py']);
  assert.equal(edges(root)['app/unrelated.py'], undefined);
});

test('go: package directory imports and same-package references', () => {
  const root = repo({
    'go.mod': 'module example.com/shop\n',
    'internal/store/store.go': 'package store\n\nfunc Open() {}\n',
    'internal/store/query.go': 'package store\n\nfunc find() { Open() }\n',
    'cmd/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/shop/internal/store"\n)\n\nfunc main() { fmt.Println(); store.Open() }\n',
  });
  const e = edges(root);
  assert.deepEqual(e['cmd/main.go'], ['internal/store/store.go']);
  assert.deepEqual(e['internal/store/query.go'], ['internal/store/store.go']);
});

test('java: imports resolve to the class file under any source root', () => {
  const root = repo({
    'src/main/java/com/shop/model/Order.java': 'package com.shop.model;\npublic class Order {}\n',
    'src/main/java/com/shop/web/OrderController.java': 'package com.shop.web;\nimport com.shop.model.Order;\nimport java.util.List;\npublic class OrderController { Order o; }\n',
  });
  assert.deepEqual(edges(root), { 'src/main/java/com/shop/web/OrderController.java': ['src/main/java/com/shop/model/Order.java'] });
});

test('rust: use crate paths and mod declarations', () => {
  const root = repo({
    'src/main.rs': 'mod config;\nuse crate::db::pool::connect;\nuse std::fmt;\nfn main() { connect(); }\n',
    'src/config.rs': 'pub struct Settings;\n',
    'src/db/pool.rs': 'pub fn connect() {}\n',
  });
  assert.deepEqual(edges(root), { 'src/main.rs': ['src/config.rs', 'src/db/pool.rs'] });
});

test('c: quoted includes link to the header', () => {
  const root = repo({
    'src/list.h': 'int list_len(void);\n',
    'src/main.c': '#include <stdio.h>\n#include "list.h"\nint main(void) {\n  return list_len();\n}\n',
  });
  assert.deepEqual(edges(root), { 'src/main.c': ['src/list.h'] });
});

test('map ranks the most depended-on file first and stays within budget', () => {
  const root = repo({
    'core.ts': 'export function core() {}\n',
    'a.ts': 'import { core } from "./core";\ncore();\n',
    'b.ts': 'import { core } from "./core";\ncore();\n',
  });
  const { files, graph, truncated } = analyze(root);
  const map = renderMap({ files, graph, truncated, budget: 200, queryCommand: 'armap' });
  const listed = map.split('\n').filter((l) => /^\S+\.ts/.test(l));
  assert.match(listed[0], /^core\.ts \(used by 2\)/);
  assert.ok(map.length / 3.5 <= 200);
});

test('files over 256 KB are mapped from their first 256 KB and marked partial', () => {
  const filler = '// padding\n'.repeat(Math.ceil((300 * 1024) / 11));
  const root = repo({
    'big.ts': `export function early() {}\n${filler}export function late() {}\n`,
    'app.ts': 'import { early } from "./big";\nearly();\n',
  });
  const { files, graph, truncated } = analyze(root);
  const big = files.findIndex((f) => f.path === 'big.ts');
  assert.deepEqual(files[big].defs.map((d) => d.name), ['early']);
  const map = renderMap({ files, graph, truncated, budget: 300, queryCommand: 'armap' });
  assert.match(map, /^Partial \(over 256 KB, only the first 256 KB read\): big\.ts$/m);
  assert.match(map, /^big\.ts \(used by 1; partial, 300 KB\)$/m);
  assert.match(map, /L1 export function early\(\)/);
  assert.match(renderDeps({ files, graph, index: big }), /^big\.ts \(partial: only the first 256 KB of 300 KB read\)/);
});

test('the partial-files note names at most three files', () => {
  const filler = 'x\n'.repeat(140 * 1024);
  const root = repo(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.js`, filler])));
  const { files, graph, truncated } = analyze(root);
  const map = renderMap({ files, graph, truncated, budget: 300, queryCommand: 'armap' });
  assert.match(map, /^Partial \(over 256 KB, only the first 256 KB read\): a\.js, b\.js, c\.js \(\+2 more\)$/m);
});

const entries = (root) => analyze(root).files.filter((f) => f.entry).map((f) => f.path).sort();

test('monorepo: package.json bin, main and exports mark entry points, mapped from dist/ to src/', () => {
  const lib = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`packages/core/src/${n}.ts`, `import { helper } from "./util";\nexport function ${n}One() { helper(); }\n`]));
  const root = repo({
    'package.json': '{ "private": true, "workspaces": ["packages/*"] }\n',
    'packages/core/package.json': '{ "main": "dist/index.js", "exports": { ".": "./dist/index.js", "./*": "./dist/*.js" } }\n',
    'packages/core/src/index.ts': 'export * from "./util";\n',
    'packages/core/src/util.ts': 'export function helper() {}\n',
    ...lib,
    'packages/cli/package.json': '{ "name": "tool", "bin": { "tool": "./bin/tool.js" } }\n',
    'packages/cli/bin/tool.js': 'import { run } from "../src/run.js";\nrun();\n',
    'packages/cli/src/run.js': 'export function run() {}\n',
  });
  assert.deepEqual(entries(root), ['packages/cli/bin/tool.js', 'packages/core/src/index.ts']);

  const { files, graph, truncated } = analyze(root);
  const map = renderMap({ files, graph, truncated, budget: 4000, queryCommand: 'armap' });
  const listed = map.split('\n').filter((l) => /^packages\//.test(l));
  const at = (path) => listed.findIndex((l) => l.startsWith(`${path} `));
  assert.match(listed[at('packages/cli/bin/tool.js')], /\(entry\)$/);
  // Without the lift these two rank last, since nothing imports them.
  assert.ok(at('packages/cli/bin/tool.js') <= 6, map);
  assert.ok(at('packages/core/src/index.ts') <= 6, map);
  assert.equal(listed[0].split(' ')[0], 'packages/core/src/util.ts');
});

test('cargo, pyproject, go and python __main__ entry points', () => {
  const root = repo({
    'rs/Cargo.toml': '[package]\nname = "x"\n\n[[bin]]\nname = "gen"\npath = "tools/gen.rs"\n',
    'rs/src/main.rs': 'fn main() {}\n',
    'rs/src/bin/extra.rs': 'fn main() {}\n',
    'rs/src/util.rs': 'pub fn util() {}\n',
    'rs/tools/gen.rs': 'fn main() {}\n',
    'py/pyproject.toml': '[project]\nname = "app"\n\n[project.scripts]\napp = "app.cli:main"\n\n[tool.other]\nx = "app.models:y"\n',
    'py/src/app/cli.py': 'def main():\n    pass\n',
    'py/src/app/models.py': 'class Y:\n    pass\n',
    'py/src/app/__main__.py': 'from app.cli import main\nmain()\n',
    'go/cmd/server/main.go': 'package main\n\nfunc main() {}\n',
    'go/cmd/server/main_test.go': 'package main\n\nfunc main() {}\n',
    'go/internal/store.go': 'package store\n\nfunc Open() {}\n',
  });
  assert.deepEqual(entries(root), [
    'go/cmd/server/main.go', 'py/src/app/__main__.py', 'py/src/app/cli.py',
    'rs/src/bin/extra.rs', 'rs/src/main.rs', 'rs/tools/gen.rs',
  ]);
});
