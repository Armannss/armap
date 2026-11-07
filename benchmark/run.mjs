#!/usr/bin/env node
// Runs each question against a repository in several conditions and reports task success
// first, then token use, split by question type.
//
//   node benchmark/run.mjs --repo <dir> --questions <file.json>
//     [--model sonnet] [--trials 5] [--conditions none,tree,armap] [--out results.json]
//
// Conditions:
//   none   no plugin
//   tree   a plain, unranked file tree of the same files, capped at the same budget (benchmark/tree-baseline)
//   armap  the armap plugin
//
// questions file: [{ "id": "q1", "type": "topology", "question": "...", "expect": ["substring", ...] }]
// "type" groups questions in the report. Use "topology" for questions that span files
// (rename impact, how a subsystem works) and "lookup" for ones a single search can answer.
// An answer counts as correct when it contains every "expect" substring.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = { none: null, tree: resolve(ROOT, 'benchmark/tree-baseline'), armap: ROOT };
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
// Read-only tools, identical in every condition. `node` is needed for the plugin's queries.
const TOOLS = 'Read,Grep,Glob,Bash(node:*)';

function parseArgs(argv) {
  const opts = { model: 'sonnet', trials: '5', conditions: 'none,tree,armap' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`Expected "--option value", got "${argv[i]}"`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.repo || !opts.questions) throw new Error('--repo and --questions are required');
  opts.trials = Number(opts.trials);
  if (!Number.isInteger(opts.trials) || opts.trials < 1) throw new Error('--trials must be a positive whole number');
  opts.conditions = opts.conditions.split(',').map((c) => c.trim()).filter(Boolean);
  const unknown = opts.conditions.filter((c) => !(c in PLUGINS));
  if (unknown.length) throw new Error(`Unknown condition "${unknown[0]}". Use: ${Object.keys(PLUGINS).join(', ')}`);
  if (!opts.conditions.length) throw new Error('--conditions needs at least one condition');
  return opts;
}

function ask({ repo, model, question, condition }) {
  const args = ['-p', question, '--output-format', 'json', '--model', model,
    '--allowedTools', TOOLS, '--no-session-persistence'];
  if (PLUGINS[condition]) args.push('--plugin-dir', PLUGINS[condition]);
  return new Promise((done) => {
    const child = spawn(CLAUDE, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => done({ error: err.message }));
    child.on('close', () => {
      try {
        const r = JSON.parse(stdout);
        const u = r.usage ?? {};
        const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        done({
          error: r.is_error ? String(r.result) : null,
          answer: String(r.result ?? ''),
          inputTokens: input,
          outputTokens: u.output_tokens ?? 0,
          totalTokens: input + (u.output_tokens ?? 0),
          costUsd: r.total_cost_usd ?? null,
          turns: r.num_turns ?? null,
          seconds: r.duration_ms ? r.duration_ms / 1000 : null,
        });
      } catch {
        done({ error: (stderr || stdout).trim().slice(0, 300) || 'no output' });
      }
    });
  });
}

const isCorrect = (answer, expect) => expect.every((s) => answer.includes(s));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-');
const kfmt = (n) => (Number.isFinite(n) ? `${Math.round(n / 1000)}k` : '-');
const pct = (n) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${(n * 100).toFixed(0)}%` : '-');

// Builds the report from the raw runs. Exported so it can be tested without calling Claude.
export function report({ questions, runs, conditions, trials, model }) {
  const out = [];
  const base = conditions[0];
  const types = [...new Set(questions.map((q) => q.type ?? 'untyped'))];
  const typeOf = (id) => questions.find((q) => q.id === id)?.type ?? 'untyped';
  const pick = (filter) => runs.filter(filter);
  const ok = (rs) => rs.filter((r) => !r.error);

  out.push('## Task success', '', 'Correct answers out of all runs. Failed runs count as incorrect.', '');
  out.push(`| type | questions | ${conditions.join(' | ')} |`, `|---|---:|${conditions.map(() => '---:').join('|')}|`);
  for (const type of [...types, 'all']) {
    const inType = (r) => type === 'all' || typeOf(r.id) === type;
    const n = type === 'all' ? questions.length : questions.filter((q) => (q.type ?? 'untyped') === type).length;
    const cells = conditions.map((c) => {
      const rs = pick((r) => r.condition === c && inType(r));
      return `${rs.filter((r) => r.correct).length}/${rs.length}`;
    });
    out.push(`| ${type === 'all' ? '**all**' : type} | ${n} | ${cells.join(' | ')} |`);
  }

  out.push('', '## Tokens per question', '',
    `Median total tokens across successful runs, with min to max. Change is median against "${base}".`, '');
  const header = conditions.map((c) => (c === base ? c : `${c} | change`)).join(' | ');
  out.push(`| question | type | ${header} | correct (${conditions.join(' / ')}) |`,
    `|---|---|${conditions.map((c) => (c === base ? '---:' : '---:|---:')).join('|')}|---:|`);
  const medians = {};
  for (const q of questions) {
    medians[q.id] = {};
    const cells = [], correct = [];
    for (const c of conditions) {
      const rs = pick((r) => r.id === q.id && r.condition === c);
      const toks = ok(rs).map((r) => r.totalTokens);
      medians[q.id][c] = median(toks);
      const spread = toks.length > 1 ? ` (${kfmt(Math.min(...toks))}–${kfmt(Math.max(...toks))})` : '';
      cells.push(`${fmt(median(toks))}${spread}`);
      if (c !== base) cells.push(pct(median(toks) / medians[q.id][base] - 1));
      correct.push(`${rs.filter((r) => r.correct).length}/${rs.length}`);
    }
    out.push(`| ${q.id} | ${q.type ?? 'untyped'} | ${cells.join(' | ')} | ${correct.join(' / ')} |`);
  }

  out.push('', '## Tokens by question type', '',
    'Sum of per-question medians. Report these separately: a total across types hides opposite effects.', '');
  out.push(`| type | ${header} |`, `|---|${conditions.map((c) => (c === base ? '---:' : '---:|---:')).join('|')}|`);
  for (const type of types) {
    const ids = questions.filter((q) => (q.type ?? 'untyped') === type).map((q) => q.id);
    const sum = (c) => ids.reduce((s, id) => s + medians[id][c], 0);
    const cells = [];
    for (const c of conditions) {
      cells.push(fmt(sum(c)));
      if (c !== base) cells.push(pct(sum(c) / sum(base) - 1));
    }
    out.push(`| ${type} | ${cells.join(' | ')} |`);
  }

  const errors = runs.filter((r) => r.error).length;
  const cost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  out.push('', `model: ${model}, trials per condition: ${trials}, runs: ${runs.length}, failed runs: ${errors}, benchmark cost: $${cost.toFixed(2)}`);
  if (trials < 5) out.push(`Note: ${trials} trial(s) per condition is too few to trust differences of a few percent.`);
  return out.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = resolve(opts.repo);
  const questions = JSON.parse(readFileSync(opts.questions, 'utf8'));
  const runs = [];

  for (const q of questions) {
    for (let trial = 1; trial <= opts.trials; trial++) {
      // All conditions run at the same time so none benefits from a warmer prompt cache.
      const results = await Promise.all(opts.conditions.map((condition) =>
        ask({ repo, model: opts.model, question: q.question, condition })));
      opts.conditions.forEach((condition, i) => {
        const r = results[i];
        runs.push({ id: q.id, type: q.type ?? 'untyped', trial, condition, ...r,
          correct: r.error ? false : isCorrect(r.answer, q.expect ?? []) });
      });
      const line = (r) => (r.error ? `ERROR ${r.error}` : `${fmt(r.totalTokens)} tok, ${r.turns} turns`);
      console.error(`${q.id} #${trial}  ${opts.conditions.map((c, i) => `${c}: ${line(results[i])}`).join('  |  ')}`);
    }
  }

  console.log(report({ questions, runs, conditions: opts.conditions, trials: opts.trials, model: opts.model }));
  if (opts.out) writeFileSync(opts.out, JSON.stringify({ repo, model: opts.model, conditions: opts.conditions, trials: opts.trials, runs }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
