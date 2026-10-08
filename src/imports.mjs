// Finds import statements and resolves them to files in the repository, so a link between
// two files rests on a real import rather than on a shared name alone.
import { posix } from 'node:path';

const JS = new Set(['javascript', 'typescript', 'vue', 'svelte', 'astro']);
const C = new Set(['c', 'cpp', 'objc']);
const JVM_LIKE = new Set(['java', 'kotlin', 'scala', 'groovy']);
// Languages where a file can only use another file's symbols by importing it.
export const EXPLICIT = new Set([...JS, 'python', 'dart']);

const INDEX_STEMS = new Set(['index', '__init__', 'mod']);
const stripExt = (p) => p.replace(/\.[A-Za-z0-9]+$/, '');
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function each(re, text, fn) {
  re.lastIndex = 0;
  for (let m; (m = re.exec(text));) fn(m);
}

// A spec is either { path } (slash separated, maybe relative) or { segs } (a dotted or
// namespaced name), with flags saying how loosely it may be matched:
//   trail  - how many trailing segments may be dropped (they may name a symbol, not a file)
//   lead   - leading segments may be dropped (module or vendor prefix)
//   dirs   - may refer to a directory of files (a package)
//   single - a one-segment name is allowed to match
export function importSpecs(text, lang) {
  const specs = [];
  if (JS.has(lang)) {
    each(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g, text, (m) => specs.push({ path: m[2] }));
  } else if (lang === 'python') {
    each(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm, text, (m) => {
      const names = m[3].replace(/[()]/g, '').split(',').map((n) => n.trim().split(/\s+/)[0]).filter((n) => /^\w+$/.test(n));
      if (m[1]) {
        const base = `./${'../'.repeat(m[1].length - 1)}${m[2].replace(/\./g, '/')}`;
        if (m[2]) specs.push({ path: base, relative: true });
        for (const n of names) specs.push({ path: `${base}/${n}`, relative: true });
      } else if (m[2]) {
        const segs = m[2].split('.');
        specs.push({ segs, single: true });
        for (const n of names) specs.push({ segs: [...segs, n] });
      }
    });
    each(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm, text, (m) => {
      for (const part of m[1].split(',')) specs.push({ segs: part.trim().split(/\s+/)[0].split('.'), single: true });
    });
  } else if (lang === 'go') {
    each(/^[ \t]*(?:import[ \t]+)?(?:[\w.]+[ \t]+)?"([\w.\-/]+)"[ \t]*$/gm, text, (m) => specs.push({ path: m[1], dirs: true, lead: true }));
  } else if (lang === 'rust') {
    each(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([\w:]+)/gm, text, (m) => {
      const parts = m[1].split('::').filter(Boolean);
      const local = ['crate', 'self', 'super'].includes(parts[0]);
      const segs = parts.filter((p) => !['crate', 'self', 'super'].includes(p));
      if (segs.length) specs.push({ segs, trail: 3, single: local });
    });
    each(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm, text, (m) => specs.push({ mod: m[1] }));
  } else if (C.has(lang)) {
    each(/^[ \t]*#[ \t]*(?:include|import)[ \t]*"([^"\n]+)"/gm, text, (m) => specs.push({ path: m[1], relative: true, orSuffix: true }));
  } else if (JVM_LIKE.has(lang)) {
    each(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm, text, (m) => specs.push({ segs: m[1].split('.').filter(Boolean), trail: 2, dirs: true }));
  } else if (lang === 'csharp') {
    each(/^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:\w+[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm, text, (m) => specs.push({ segs: m[1].split('.'), trail: 1, lead: true, dirs: true }));
  } else if (lang === 'ruby') {
    each(/^[ \t]*require(_relative)?[ \t]*\(?[ \t]*['"]([^'"\n]+)['"]/gm, text, (m) => specs.push(m[1] ? { path: `./${m[2]}`, relative: true } : { path: m[2] }));
  } else if (lang === 'php') {
    each(/^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([\w\\]+)/gm, text, (m) => specs.push({ segs: m[1].split('\\').filter(Boolean), trail: 1, lead: true }));
    each(/\b(?:require|include)(?:_once)?[ \t]*\(?[^'"\n;]*['"]([^'"\n]+)['"]/g, text, (m) => specs.push({ path: m[1].replace(/^\//, ''), relative: true, orSuffix: true }));
  } else if (lang === 'dart') {
    each(/^[ \t]*(?:import|export|part)[ \t]+['"]([^'"\n]+)['"]/gm, text, (m) => {
      if (m[1].startsWith('dart:')) return;
      const pkg = /^package:[^/]+\/(.+)$/.exec(m[1]);
      specs.push(pkg ? { path: pkg[1] } : { path: m[1], relative: true });
    });
  } else if (lang === 'elixir') {
    each(/^[ \t]*(?:alias|import|use|require)[ \t]+([A-Z][\w.]*)/gm, text, (m) => specs.push({ segs: m[1].split('.').map(snake), trail: 1 }));
  }
  return specs;
}

const endsWith = (segs, tail) => tail.length <= segs.length && tail.every((s, k) => segs[segs.length - tail.length + k] === s);

// files: [{ path, lang, specs }]. Adds `imports` (files imported directly) and
// `packageImports` (files in an imported package directory) to each file.
export function resolveImports(files) {
  const byNoExt = new Map(); // extensionless path, or directory of an index file -> file indexes
  const byStem = new Map(); // last segment -> [{ index, segs }]
  const byDirName = new Map(); // last directory segment -> [{ segs, files }]
  const dirs = new Map();
  const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };

  files.forEach((f, index) => {
    const noExt = stripExt(f.path);
    const dir = posix.dirname(f.path);
    const keys = [noExt];
    if (INDEX_STEMS.has(posix.basename(noExt)) && dir !== '.') keys.push(dir);
    for (const key of keys) {
      push(byNoExt, key, index);
      const segs = key.toLowerCase().split('/');
      push(byStem, segs[segs.length - 1], { index, segs });
    }
    push(dirs, dir, index);
  });
  for (const [dir, members] of dirs) {
    if (dir === '.') continue;
    const segs = dir.toLowerCase().split('/');
    push(byDirName, segs[segs.length - 1], { segs, files: members });
  }

  const dirSegs = files.map((f) => posix.dirname(f.path).split('/'));
  const depth = (index) => files[index].path.split('/').length;

  // Among several files matching the same name, keep the ones nearest the importing file.
  function nearest(matches, from) {
    if (matches.length <= 1) return matches;
    const shared = (index) => { let k = 0; while (k < dirSegs[from].length && dirSegs[index][k] === dirSegs[from][k]) k++; return k; };
    const best = Math.max(...matches.map(shared));
    const kept = matches.filter((index) => shared(index) === best);
    return kept.length <= 3 ? kept : [];
  }

  function matchSegs(from, rawSegs, { trail = 0, lead = false, dirs: allowDirs = false, single = false }) {
    const segs = rawSegs.map((s) => s.toLowerCase());
    for (let t = 0; t <= trail && t < segs.length; t++) {
      const kept = segs.slice(0, segs.length - t);
      for (let l = 0; l < (lead ? kept.length : 1); l++) {
        const s = kept.slice(l);
        if (s.length === 1 && !(single && t === 0 && l === 0)) break;
        let found = (byStem.get(s[s.length - 1]) ?? []).filter((c) => endsWith(c.segs, s)).map((c) => c.index);
        // A lone name only counts for a file beside the importer or near the repository root.
        if (s.length === 1) found = found.filter((index) => dirSegs[index].join('/') === dirSegs[from].join('/') || depth(index) <= 2);
        found = nearest([...new Set(found)], from);
        if (found.length) return { direct: found };
        if (allowDirs) {
          const members = (byDirName.get(s[s.length - 1]) ?? []).filter((d) => endsWith(d.segs, s))
            .flatMap((d) => d.files).filter((index) => files[index].lang === files[from].lang);
          if (members.length) return { viaPackage: members };
        }
      }
    }
    return {};
  }

  function resolve(from, spec) {
    const f = files[from];
    const dir = posix.dirname(f.path);
    if (spec.mod) {
      const stem = posix.basename(stripExt(f.path));
      for (const p of [posix.join(dir, spec.mod), posix.join(dir, stem, spec.mod)]) if (byNoExt.has(p)) return { direct: byNoExt.get(p) };
      return {};
    }
    if (spec.segs) return matchSegs(from, spec.segs, spec);

    let p = spec.path.split('?')[0];
    if (spec.relative || p.startsWith('.')) {
      const target = posix.normalize(posix.join(dir, p));
      const hit = byNoExt.get(target) ?? byNoExt.get(stripExt(target));
      if (hit) return { direct: hit };
      if (!spec.orSuffix) return {};
    }
    const js = JS.has(f.lang);
    const alias = js && /^[@~#]\//.test(p);
    if (alias) p = p.slice(2);
    let segs = p.split('/').filter((s) => s && s !== '.' && s !== '..');
    if (js && !alias && segs[0]?.startsWith('@')) segs = segs.slice(1);
    if (!segs.length || (js && !alias && segs.length < 2)) return {};
    if (!spec.dirs) segs[segs.length - 1] = stripExt(segs[segs.length - 1]) || segs[segs.length - 1];
    return matchSegs(from, segs, { lead: spec.lead, dirs: spec.dirs, single: !js || alias });
  }

  files.forEach((f, from) => {
    f.imports = new Set();
    f.packageImports = new Set();
    for (const spec of f.specs) {
      const { direct = [], viaPackage = [] } = resolve(from, spec);
      for (const index of direct) if (index !== from) f.imports.add(index);
      for (const index of viaPackage) if (index !== from) f.packageImports.add(index);
    }
  });
}
