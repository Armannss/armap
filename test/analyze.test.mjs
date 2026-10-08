import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { analyze } from '../src/analyze.mjs';
import { renderMap } from '../src/render.mjs';

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
