// Entry points: files a program or package starts from. Nothing imports them, so ranking by
// dependents alone puts them last, although they are often the first file worth reading.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Cargo.toml']);
export const isManifest = (rel) => MANIFESTS.has(posix.basename(rel));

// package.json often points at build output; the source usually sits under src/ with the same name.
const BUILD_DIR = /^(?:dist|build|lib|out|es|esm|cjs)\//;
const stripExt = (p) => p.replace(/\.[A-Za-z0-9]+$/, '');

function packageJson(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return []; }
  const found = [];
  const collect = (v) => {
    if (typeof v === 'string') found.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
  };
  for (const key of ['bin', 'main', 'module', 'exports']) collect(pkg?.[key]);
  return found.filter((p) => !p.includes('*')).map((p) => ({ path: p, fromBuild: true }));
}

// Lines of the given [sections] of a TOML file, as [key, value] pairs with quotes removed.
function tomlPairs(text, sections) {
  const pairs = [];
  let current = null;
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) { current = header[1]; continue; }
    if (!sections.has(current)) continue;
    const pair = /^\s*([\w.-]+|"[^"]*")\s*=\s*["']([^"']+)["']/.exec(line);
    if (pair) pairs.push([pair[1].replace(/"/g, ''), pair[2]]);
  }
  return pairs;
}

function pyproject(text) {
  const scripts = tomlPairs(text, new Set(['project.scripts', 'project.gui-scripts', 'tool.poetry.scripts']));
  return scripts.flatMap(([, target]) => {
    const mod = target.split(':')[0].trim().replace(/\./g, '/');
    return ['', 'src/'].flatMap((base) => [{ path: `${base}${mod}.py` }, { path: `${base}${mod}/__init__.py` }]);
  });
}

function cargo(text) {
  const paths = tomlPairs(text, new Set(['bin', 'lib'])).filter(([k]) => k === 'path').map(([, p]) => ({ path: p }));
  return [{ path: 'src/main.rs' }, { path: 'src/lib.rs' }, { prefix: 'src/bin/' }, ...paths];
}

const PARSERS = { 'package.json': packageJson, 'pyproject.toml': pyproject, 'Cargo.toml': cargo };

// A Go `package main` file with a main function, or a Python `__main__.py`.
export const isMainFile = (path, lang, text) =>
  (lang === 'go' && !path.endsWith('_test.go') && /^package main\b/m.test(text) && /^func main\(\)/m.test(text))
  || posix.basename(path) === '__main__.py';

// Marks `entry: true` on files that a package manifest declares as entry points.
export function markEntries(root, manifests, files) {
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const byNoExt = new Map();
  files.forEach((f, i) => { if (!byNoExt.has(stripExt(f.path))) byNoExt.set(stripExt(f.path), i); });

  const find = (dir, { path, prefix, fromBuild }) => {
    if (prefix) {
      const start = posix.join(dir, prefix);
      return files.flatMap((f, i) => (f.path.startsWith(start) ? [i] : []));
    }
    const rel = posix.normalize(path).replace(/^\.\//, '');
    const candidates = [rel];
    if (fromBuild && BUILD_DIR.test(rel)) candidates.push(rel.replace(BUILD_DIR, 'src/'));
    for (const c of candidates) {
      const full = posix.join(dir, c);
      const i = byPath.get(full) ?? byNoExt.get(stripExt(full));
      if (i !== undefined) return [i];
    }
    return [];
  };

  for (const manifest of manifests) {
    let text;
    try { text = readFileSync(join(root, manifest), 'utf8'); } catch { continue; }
    const dir = posix.dirname(manifest) === '.' ? '' : posix.dirname(manifest);
    for (const target of PARSERS[posix.basename(manifest)](text)) {
      if (target.path?.startsWith('..')) continue;
      for (const i of find(dir, target)) files[i].entry = true;
    }
  }
}
