// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Cooperative-offset rollout benchmark with repeated sampling, dispersion
// statistics, and a pre-change baseline. It never mutates its input files:
// each source is copied to a temporary JSONL, indexed once, then given a
// sequence of identical suffix appends; each append is incrementally indexed
// and timed (one discarded warmup, then N measured samples).
//
// Modes measured on this build:
//   cooperative — normal read mode; expects the cooperative-append plan.
//   verified    — strict read mode; expects the verified-append plan.
//   snapshot    — a legacy 5-leg cursor on every sample; expects the snapshot
//                 plan. This is the pre-change adapter's per-append behavior
//                 (full reread + full re-emission) measured on this build.
//
// Main baseline: the same script can run inside a worktree checked out at
// origin/main. Copy it into that tree's scripts/ directory and pass
// --main-compat; every append then measures the unmodified adapter, which
// rereads and re-emits the complete file. Metrics/plan assertions are skipped
// there because the pre-change parser has no metrics seam.
//
//   node --experimental-strip-types scripts/bench-codex-cooperative-offset.mjs \
//     --source /path/to/30mb-rollout.jsonl --source /path/to/177mb-rollout.jsonl \
//     [--samples 7] [--verified]
//
// All measurements are warm-cache, in-memory SQLite, single machine. The
// cooperative path fails the run if its source I/O grows beyond two suffix
// passes. Use real Codex transcripts.

import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { persist } from '../packages/core/src/persist.ts';

const codex = await import('../packages/core/src/providers/codex.ts');
const parse = codex.parse;
const createCodexParseMetrics = typeof codex.createCodexParseMetrics === 'function'
  ? codex.createCodexParseMetrics
  : null;

const args = process.argv.slice(2);
const sources = args.flatMap((arg, index) => arg === '--source' ? [args[index + 1]] : []).filter(Boolean);
const samplesFlag = args.findIndex(arg => arg === '--samples');
const SAMPLES = samplesFlag >= 0
  ? (() => {
    const value = Number.parseInt(args[samplesFlag + 1] ?? '', 10);
    if (!Number.isInteger(value) || value < 2) throw new Error('--samples must be an integer >= 2');
    return value;
  })()
  : 7;
const mainCompat = args.includes('--main-compat');
const diagnosticVerifiedOnly = args.includes('--verified');
if (sources.length === 0) throw new Error('usage: add one or more --source <rollout.jsonl> arguments');
if (args.includes('--cooperative-only')) throw new Error('--cooperative-only is obsolete; benchmark cooperative, verified, and snapshot paths');
const MIN_SMALL_SOURCE_BYTES = 30_000_000;
const MIN_LARGE_SOURCE_BYTES = 177_000_000;
const sourceStats = sources.map(source => ({ source, stat: statSync(source) }));
if (!diagnosticVerifiedOnly
  && (!sourceStats.some(({ stat }) => stat.size >= MIN_SMALL_SOURCE_BYTES)
    || !sourceStats.some(({ stat }) => stat.size >= MIN_LARGE_SOURCE_BYTES))) {
  throw new Error('real benchmark requires sources of at least 30 MB and 177 MB; use --verified for a single-path diagnostic');
}

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const suffix = `${JSON.stringify({
  type: 'event_msg', timestamp: '2099-01-01T00:00:00Z', payload: { type: 'user_message', message: 'cooperative benchmark suffix' },
})}\n`;
const suffixBytes = Buffer.byteLength(suffix);

function ms(fn) {
  const start = performance.now();
  const value = fn();
  return { value, elapsed: performance.now() - start };
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) { values.push(step.value); step = gen.next(); }
  return { values, cursor: step.value };
}

function* replay(values, cursor) {
  yield* values;
  return cursor;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((acc, value) => acc + value, 0) / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const sd = n > 1
    ? Math.sqrt(sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (n - 1))
    : 0;
  return { mean, median, sd, min: sorted[0], max: sorted[n - 1], cv: mean > 0 ? (sd / mean) * 100 : 0 };
}

const fx = (value, digits = 2) => value.toFixed(digits);

console.log('kind\tsource\tmode\tsample\tplan\treadMiB\tjsonLines\temitted\tparseMs\tpersistMs\ttotalMs');
console.log('summary columns: source, mode, samples, sizeMiB, plan, readMiBMed, jsonLinesMed, emittedMed, '
  + 'parseMed, parseMean, parseSd, persistMed, persistMean, persistSd, totalMed, totalMean, totalSd, totalCvPct, totalMin, totalMax');
for (const { source, stat: sourceStat } of sourceStats) {
  const modes = mainCompat
    ? ['main']
    : diagnosticVerifiedOnly
      ? ['verified']
      : ['cooperative', 'verified', 'snapshot'];
  for (const benchmarkMode of modes) {
    const dir = mkdtempSync(join(tmpdir(), 'obelisk-codex-bench-'));
    const path = join(dir, basename(source));
    const db = makeDb();
    try {
      copyFileSync(source, path);
      const unit = { key: path, sessionId: '', meta: { source: 'codex', guardian: false } };
      const initial = ms(() => persist(db, unit, parse(unit, null)));
      if (initial.value === null) throw new Error(`${basename(source)} did not produce a resumable Codex cursor`);

      // A cursor without provider state never qualifies for append and forces
      // the conservative full replay on every sample: the pre-change
      // adapter's per-append behavior, measured on this build.
      const legacyCursor = initial.value.split(':', 6).slice(0, 5).join(':');
      let cursor = initial.value;
      const parseMs = [];
      const persistMs = [];
      const totalMs = [];
      const readMiB = [];
      const jsonLines = [];
      const emitted = [];
      let plan = mainCompat ? 'main-full-reparse' : '';
      for (let sample = 0; sample <= SAMPLES; sample++) {
        appendFileSync(path, suffix);
        const metrics = createCodexParseMetrics !== null ? createCodexParseMetrics() : null;
        const parseUnit = benchmarkMode === 'verified'
          ? { ...unit, meta: { ...unit.meta, readMode: 'strict' } }
          : unit;
        const inputCursor = benchmarkMode === 'snapshot' ? legacyCursor : cursor;
        const parsed = ms(() => drain(parse(parseUnit, inputCursor, metrics ?? undefined)));
        const persisted = ms(() => persist(db, parseUnit, replay(parsed.value.values, parsed.value.cursor)));
        cursor = parsed.value.cursor;
        const total = parsed.elapsed + persisted.elapsed;
        if (sample === 0) continue; // discarded warmup
        if (metrics !== null) {
          const expectedPlan = benchmarkMode === 'verified'
            ? 'verified-append'
            : benchmarkMode === 'snapshot' ? 'snapshot' : 'cooperative-append';
          if (metrics.plan !== expectedPlan) throw new Error(`${basename(source)} sample ${sample} selected ${metrics.plan}, not ${expectedPlan}`);
          if (benchmarkMode === 'cooperative' && metrics.sourceBytesRead > suffixBytes * 2) {
            throw new Error(`${basename(source)} sample ${sample} read ${metrics.sourceBytesRead} bytes for a ${suffixBytes}-byte suffix`);
          }
          plan = metrics.plan;
          readMiB.push(metrics.sourceBytesRead / 1024 / 1024);
          jsonLines.push(metrics.jsonLinesParsed);
        }
        emitted.push(parsed.value.values.length);
        parseMs.push(parsed.elapsed);
        persistMs.push(persisted.elapsed);
        totalMs.push(total);
        console.log(['sample', basename(source), benchmarkMode, String(sample), plan,
          metrics !== null ? fx(readMiB[readMiB.length - 1], 3) : '',
          metrics !== null ? String(jsonLines[jsonLines.length - 1]) : '',
          String(parsed.value.values.length),
          fx(parsed.elapsed), fx(persisted.elapsed), fx(total)].join('\t'));
      }
      const ps = stats(parseMs);
      const pr = stats(persistMs);
      const tt = stats(totalMs);
      const readMed = readMiB.length > 0 ? stats(readMiB).median : null;
      const linesMed = jsonLines.length > 0 ? stats(jsonLines).median : null;
      const emittedMed = stats(emitted).median;
      console.log(['summary', basename(source), benchmarkMode, String(SAMPLES),
        fx(sourceStat.size / 1024 / 1024, 1), plan,
        readMed !== null ? fx(readMed, 3) : '',
        linesMed !== null ? String(linesMed) : '',
        String(emittedMed),
        fx(ps.median), fx(ps.mean), fx(ps.sd),
        fx(pr.median), fx(pr.mean), fx(pr.sd),
        fx(tt.median), fx(tt.mean), fx(tt.sd), fx(tt.cv, 1), fx(tt.min), fx(tt.max)].join('\t'));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
