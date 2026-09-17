#!/usr/bin/env node
// Audit the answer keys in ANY of Brenda's quiz apps.
//
//     node ~/scripts/audit-question-banks.js <app-folder> [--relock]
//
// Why this exists: six answers in Jacob's 11+ app were mis-keyed, so the app
// told him he was WRONG when he was RIGHT, for months, and nothing noticed.
// This is the same check, made portable so it can be pointed at any app.
//
// What it checks, in order of how much it proves:
//   1. an answer index that points outside the options            (certain)
//   2. two identical options                                       (certain)
//   3. an answer index that disagrees with a stored answer TEXT    (proof)
//   4. an answer that has MOVED since the lock was taken           (proof)
//   5. a short keyed answer beside a much longer, more specific one (read it)
//   6. an explanation that quotes a DIFFERENT option                (read it)
//
// Checks 5 and 6 are only signatures. A mis-key on short options slips past
// them, which is why the lock in check 4 exists. Take the lock when the banks
// are known good, and any later answer that moves is caught.
const fs = require('fs');
const path = require('path');

const APP = path.resolve(process.argv[2] || '.');
const RELOCK = process.argv.includes('--relock');
if (!fs.existsSync(APP)) {
  console.error('No such folder: ' + APP);
  process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'venv']);

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) files(full, out);
    } else if (/\.(json|js|html)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// ── walk to a bracket's true partner, skipping strings and comments ────────
function matchBracket(src, start) {
  const open = src[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i === -1) return -1; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const banks = {};
const unread = [];

for (const file of files(APP)) {
  const rel = path.relative(APP, file);
  const src = fs.readFileSync(file, 'utf8');

  if (file.endsWith('.json')) {
    try { banks[rel] = JSON.parse(src); }
    catch (e) { if (/"options"|"opts"/.test(src)) unread.push(rel + ' (invalid JSON)'); }
    continue;
  }
  if (!/options\s*:|opts\s*:/.test(src)) continue;

  // top-level data arrays, plus scalar consts they might reference
  const decls = [];
  const scalars = [];
  let m;
  const declRe = /^(?:export\s+)?const ([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(\[|\{)/gm;
  while ((m = declRe.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const end = matchBracket(src, open);
    if (end === -1) continue;
    decls.push({ name: m[1], literal: src.slice(open, end + 1) });
  }
  const scalarRe = /^(?:export\s+)?const ([A-Za-z_][A-Za-z_0-9]*)\s*=\s*((?:'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?));?$/gm;
  while ((m = scalarRe.exec(src)) !== null) scalars.push({ name: m[1], literal: m[2] });
  if (!decls.length) continue;

  const body = scalars.map((d) => `const ${d.name} = ${d.literal};`).join('\n') + '\n'
    + decls.map((d) => `const ${d.name} = ${d.literal};`).join('\n')
    + '\nreturn {' + decls.map((d) => d.name).join(',') + '};';
  try {
    // eslint-disable-next-line no-new-func
    const got = new Function(body)();
    for (const [k, v] of Object.entries(got)) banks[`${rel}:${k}`] = v;
  } catch (e) {
    for (const d of decls) {
      try { banks[`${rel}:${d.name}`] = new Function('return ' + d.literal)(); }
      catch (err) { unread.push(`${rel}:${d.name} (${err.message.slice(0, 50)})`); }
    }
  }
}

// ── find question-shaped objects ───────────────────────────────────────────
// Options come in four shapes across these apps, and a checker that only knows
// one silently passes the other three. That is how a fault hides.
//   1. ["a","b"]          with a numeric index
//   2. ["A) a","B) b"]    with a letter answer, "B"
//   3. ["a","b"]          with the answer as TEXT, or an array of texts
//   4. {A:"a", B:"b"}     with a letter answer
function optionList(o) {
  const raw = o.options || o.opts;
  if (Array.isArray(raw) && raw.length >= 2 && raw.every((x) => typeof x === 'string')) {
    return { list: raw, keys: null };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length >= 2 && keys.every((k) => typeof raw[k] === 'string')) {
      return { list: keys.map((k) => raw[k]), keys };
    }
  }
  return null;
}

function* walk(o, p) {
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) yield* walk(o[i], `${p}[${i}]`);
  } else if (o && typeof o === 'object') {
    if (optionList(o)) yield [p, o];
    for (const k of Object.keys(o)) {
      if (k === 'options' || k === 'opts') continue;
      yield* walk(o[k], `${p}.${k}`);
    }
  }
}
const idxOf = (q) => {
  for (const k of ['ans', 'answer', 'correct', 'correctIndex', 'a', 'correctAnswer']) {
    if (typeof q[k] === 'number') return [k, q[k]];
  }
  return [null, null];
};
const textOf = (q) => {
  for (const k of ['answer', 'correctAnswer', 'correctText']) {
    if (typeof q[k] === 'string' && q[k].trim()) return [k, q[k].trim()];
  }
  return [null, null];
};

const LOCK = path.join(APP, '.answer-lock.json');
let lock = {};
try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')).answers || {}; } catch (e) { /* none yet */ }
const newLock = {};

const faults = [];
const toRead = [];
let checked = 0;
const per = {};

for (const [bank, data] of Object.entries(banks)) {
  let n = 0;
  for (const [p, q] of walk(data, bank)) {
    const shape = optionList(q);
    if (!shape) continue;
    const opts = shape.list;
    n++; checked++;
    const stem = q.question || q.stem || q.q || q.prompt || '';

    // resolve the answer to an index, whatever form it is written in
    let idx = null, keyDesc = null;
    const [numKey, numIdx] = idxOf(q);
    const rawAnswer = q.answer !== undefined ? q.answer
      : q.correct !== undefined ? q.correct
        : q.ans !== undefined ? q.ans : undefined;

    if (Array.isArray(rawAnswer)) {           // multi-select, answers as text
      const missing = rawAnswer.filter((a) => !opts.some((o) => o.trim() === String(a).trim()));
      if (missing.length) {
        faults.push(`${p}: answer "${String(missing[0]).slice(0, 40)}" is not one of the options`);
        continue;
      }
      idx = opts.findIndex((o) => o.trim() === String(rawAnswer[0]).trim());
      keyDesc = 'text list';
    } else if (typeof rawAnswer === 'string' && /^[A-Za-z]$/.test(rawAnswer.trim())) {
      const letter = rawAnswer.trim().toUpperCase();
      if (shape.keys) {                        // {A:…} form
        idx = shape.keys.indexOf(letter);
        if (idx === -1) { faults.push(`${p}: answer "${letter}" is not one of the option letters ${shape.keys.join('')}`); continue; }
      } else {                                 // ["A) …"] form
        idx = opts.findIndex((o) => new RegExp('^\\s*' + letter + '[).:\\s]').test(o));
        if (idx === -1) idx = letter.charCodeAt(0) - 65;
        if (!(idx >= 0 && idx < opts.length)) { faults.push(`${p}: answer letter "${letter}" has no matching option`); continue; }
      }
      keyDesc = 'letter';
    } else if (typeof rawAnswer === 'string' && rawAnswer.trim()) {
      idx = opts.findIndex((o) => o.trim() === rawAnswer.trim());
      if (idx === -1) { faults.push(`${p}: answer text "${rawAnswer.slice(0, 40)}" is not one of the options`); continue; }
      keyDesc = 'text';
    } else if (numKey !== null) {
      idx = numIdx;
      keyDesc = numKey;
      if (!(idx >= 0 && idx < opts.length)) {
        faults.push(`${p}: answer index ${idx} outside ${opts.length} options`); continue;
      }
    } else {
      faults.push(`${p}: no answer key`); continue;
    }

    const [tk, tt] = textOf(q);
    if (tt !== null && keyDesc !== 'text' && keyDesc !== 'letter' && keyDesc !== tk
        && opts[idx].trim() !== tt) {
      faults.push(`${p}: MIS-KEY PROVEN. index gives "${opts[idx].slice(0, 45)}" but ${tk} says "${tt.slice(0, 45)}"`);
    }
    if (new Set(opts.map((o) => o.trim())).size !== opts.length) {
      faults.push(`${p}: duplicate options`);
    }
    const lockKey = `${bank} :: ${String(stem).slice(0, 110)} :: ${[...opts].sort().join('~').slice(0, 150)}`;
    newLock[lockKey] = opts[idx];
    if (!RELOCK && Object.prototype.hasOwnProperty.call(lock, lockKey) && lock[lockKey] !== opts[idx]) {
      faults.push(`${p}: ANSWER CHANGED. was "${String(lock[lockKey]).slice(0, 40)}" now "${opts[idx].slice(0, 40)}"`);
    }

    const why = String(q.why || q.explanation || q.workingOut || q.e || '');
    const keyed = opts[idx];
    const longest = opts.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (longest !== keyed && longest.length > Math.max(20, keyed.length * 1.5)) {
      toRead.push({ p, stem: String(stem).slice(0, 80), keyed: keyed.slice(0, 65), note: 'longer option: ' + longest.slice(0, 65) });
    } else if (why.length > 15) {
      const w = why.toLowerCase();
      const whole = (needle) => {
        const nd = needle.toLowerCase().replace(/[.!?]$/, '').trim();
        if (nd.length < 6) return false;
        return new RegExp('(^|[^a-z])' + nd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])', 'i').test(w);
      };
      const others = opts.filter((o, i) => i !== idx && whole(o));
      if (!w.includes(keyed.toLowerCase().replace(/[.!?]$/, '').trim()) && others.length === 1) {
        toRead.push({ p, stem: String(stem).slice(0, 80), keyed: keyed.slice(0, 65), note: 'explanation quotes "' + others[0].slice(0, 50) + '" instead' });
      }
    }
  }
  if (n) per[bank] = n;
}

if (RELOCK) {
  fs.writeFileSync(LOCK, JSON.stringify({
    note: 'Verified answer TEXT of every question. The audit fails if one silently changes.',
    lockedOn: new Date().toISOString().slice(0, 10),
    answers: newLock
  }, null, 1) + '\n');
  console.log(`RE-LOCKED ${Object.keys(newLock).length} answers into ${LOCK}\n`);
}

console.log(`${path.basename(APP)}: ${checked} questions in ${Object.keys(per).length} banks`);
Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, v]) => console.log('   ' + String(v).padStart(5) + '  ' + k));
if (Object.keys(per).length > 12) console.log(`   … and ${Object.keys(per).length - 12} more banks`);

if (unread.length) {
  console.log('\nCOULD NOT BE READ, so NOT checked:');
  unread.slice(0, 10).forEach((u) => console.log('   -', u));
  if (unread.length > 10) console.log(`   … and ${unread.length - 10} more`);
}

// Faults that are already known, recorded and mitigated do not block a push.
// They are listed in .known-faults.json with a reason, so the debt is visible
// rather than silently passing. Anything NEW still fails.
const KNOWN_PATH = path.join(APP, '.known-faults.json');
let known = {};
try { known = JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')).faults || {}; } catch (e) { /* none */ }
const knownKey = (f) => f.split(':')[0];
const newFaults = faults.filter((f) => !Object.prototype.hasOwnProperty.call(known, knownKey(f)));
const oldFaults = faults.filter((f) => Object.prototype.hasOwnProperty.call(known, knownKey(f)));

if (oldFaults.length) {
  console.log(`\nKNOWN AND ALREADY MITIGATED: ${oldFaults.length}`);
  const reasons = new Set(oldFaults.map((f) => known[knownKey(f)]));
  reasons.forEach((r) => console.log('   ' + r));
}

console.log(`\nNEW FAULTS: ${newFaults.length}`);
newFaults.slice(0, 30).forEach((f) => console.log('   -', f));
if (newFaults.length > 30) console.log(`   … and ${newFaults.length - 30} more`);

console.log(`\nWORTH READING BY EYE: ${toRead.length}`);
toRead.slice(0, 15).forEach((s) => {
  console.log(`   ${s.p}`);
  console.log(`      Q     : ${s.stem}`);
  console.log(`      keyed : ${s.keyed}`);
  console.log(`      ${s.note}`);
});
if (toRead.length > 15) console.log(`   … and ${toRead.length - 15} more`);

process.exit(newFaults.length ? 1 : 0);
