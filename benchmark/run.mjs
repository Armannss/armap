#!/usr/bin/env node
// Runs each question against a repository twice, with and without the plugin, and
// compares token use and answer correctness.
//
//   node benchmark/run.mjs --repo <dir> --questions <file.json> [--model sonnet] [--trials 1] [--out results.json]
//
// questions file: [{ "id": "q1", "question": "...", "expect": ["substring", ...] }]
// An answer counts as correct when it contains every "expect" substring.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
// Read-only tools, identical in both conditions. `node` is needed for the plugin's queries.
const TOOLS = 'Read,Grep,Glob,Bash(node:*)';

function parseArgs(argv) {
  const opts = { model: 'sonnet', trials: 1 };
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!opts.repo || !opts.questions) throw new Error('--repo and --questions are required');
  opts.trials = Number(opts.trials);
  return opts;
}

function ask({ repo, model, question, withPlugin }) {
  const args = ['-p', question, '--output-format', 'json', '--model', model,
    '--allowedTools', TOOLS, '--no-session-persistence'];
  if (withPlugin) args.push('--plugin-dir', PLUGIN_DIR);
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

const correct = (answer, expect) => expect.every((s) => answer.includes(s));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = resolve(opts.repo);
  const questions = JSON.parse(readFileSync(opts.questions, 'utf8'));
  const runs = [];

  for (const q of questions) {
    for (let trial = 1; trial <= opts.trials; trial++) {
      // Both conditions run at the same time so neither benefits from a warmer prompt cache.
      const [baseline, armap] = await Promise.all([false, true].map((withPlugin) =>
        ask({ repo, model: opts.model, question: q.question, withPlugin })));
      for (const [condition, r] of [['baseline', baseline], ['armap', armap]]) {
        runs.push({ id: q.id, trial, condition, ...r, correct: r.error ? false : correct(r.answer, q.expect ?? []) });
      }
      const line = (r) => (r.error ? `ERROR ${r.error}` : `${fmt(r.totalTokens)} tok, ${r.turns} turns`);
      console.error(`${q.id} #${trial}  baseline: ${line(baseline)}  |  armap: ${line(armap)}`);
    }
  }

  const rows = questions.map((q) => {
    const of = (c) => runs.filter((r) => r.id === q.id && r.condition === c && !r.error);
    const b = of('baseline'), a = of('armap');
    const bt = mean(b.map((r) => r.totalTokens)), at = mean(a.map((r) => r.totalTokens));
    return {
      id: q.id, baselineTokens: bt, armapTokens: at, change: (at - bt) / bt,
      baselineTurns: mean(b.map((r) => r.turns)), armapTurns: mean(a.map((r) => r.turns)),
      baselineCorrect: `${b.filter((r) => r.correct).length}/${opts.trials}`,
      armapCorrect: `${a.filter((r) => r.correct).length}/${opts.trials}`,
    };
  });

  console.log('| question | baseline tokens | armap tokens | change | turns (base/armap) | correct (base/armap) |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${fmt(r.baselineTokens)} | ${fmt(r.armapTokens)} | ${(r.change * 100).toFixed(0)}% | ${r.baselineTurns}/${r.armapTurns} | ${r.baselineCorrect} / ${r.armapCorrect} |`);
  }
  const bt = rows.reduce((s, r) => s + r.baselineTokens, 0), at = rows.reduce((s, r) => s + r.armapTokens, 0);
  console.log(`| **total** | ${fmt(bt)} | ${fmt(at)} | ${(((at - bt) / bt) * 100).toFixed(0)}% | | |`);
  const cost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  console.log(`\nmodel: ${opts.model}, trials: ${opts.trials}, benchmark cost: $${cost.toFixed(2)}`);

  if (opts.out) writeFileSync(opts.out, JSON.stringify({ repo, model: opts.model, runs }, null, 2));
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
