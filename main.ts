// main.ts is mend, the CLI SPEC.md specifies: the command line, the output and
// exit codes, safe paths, format detection, all four patch formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), matching lines at three tiers, and the
// all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, in the order the edits made them. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 3: a file as lines. `br` is the file's own line break, `fin` whether its text ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  fin: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** Section 5: matching lines at three tiers. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function eqAt(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based start positions where O occurs in F at `tier`, at or after `from`. Overlapping allowed. */
function occurrences(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!eqAt(tier, O[j]!, F[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs in F at or after `from`; -1 when it occurs at none. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(O, F, t, from).length > 0) return t;
  }
  return -1;
}

/** One line of the replacement text: a context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  /** For a context line, its index in O. */
  oPos: number;
}

/** Replace F[pos .. pos+O.length) with N. Context lines come from the file; at tier 2 the other lines are re-indented. */
function replaceLines(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const F = leadWs(lines[pos] ?? '');
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (const n of N) {
    if (n.ctx) out.push(lines[pos + n.oPos]!);
    else if (tier === 2 && n.text !== '' && !/^[ \t]*$/.test(n.text) && n.text.startsWith(P)) out.push(F + n.text.slice(P.length));
    else out.push(n.text);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** Section 6: unified diffs. */
interface UBody {
  t: ' ' | '-' | '+' | '\\';
  text: string;
}
interface UHunk {
  A: number;
  body: UBody[];
}
interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDel: boolean;
  hunks: UHunk[];
}

function bodyLine(line: string): UBody {
  if (line === '') return { t: ' ', text: '' };
  const c = line[0]!;
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return { t: c, text: line.slice(1) };
  throw new Error('not a body line');
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped, /dev/null as null. */
function headerPath(s: string): string | null {
  let p = s.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: UHunk | null = null;
  let inHeader = false;
  const flushHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.t === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      cur.hunks.push(hunk);
      hunk = null;
    }
  };
  const flushSection = (): void => {
    flushHunk();
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flushSection();
      cur = { oldPath: undefined, newPath: undefined, renameFrom: undefined, renameTo: undefined, diffOld: m[1]!, diffNew: m[2]!, isNew: false, isDel: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      hunk = { A: parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      i++;
      continue;
    }
    if (hunk !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
      } else if (isBodyLine(line)) {
        hunk.body.push(bodyLine(line));
        i++;
        continue;
      } else {
        flushHunk();
      }
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('--- ')) {
        const nx = lines[i + 1];
        if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headerPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      flushSection();
      cur = { oldPath: undefined, newPath: undefined, renameFrom: undefined, renameTo: undefined, diffOld: undefined, diffNew: undefined, isNew: false, isDel: false, hunks: [] };
      inHeader = true;
      continue;
    }
    i++;
  }
  flushSection();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastCtxPlus(h: UHunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j--) {
    const b = h.body[j]!;
    if (b.t === ' ' || b.t === '+') {
      const nx = h.body[j + 1];
      return nx !== undefined && nx.t === '\\';
    }
  }
  return false;
}

/** Apply one section's hunks, in order, to the file's text. Throws Fail('no-match', path) on a hunk that finds nothing. */
function applyHunks(startText: string, hunks: UHunk[], strict: boolean, path: string): string {
  let f = splitFile(startText);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of h.body) {
      if (b.t === ' ') {
        O.push(b.text);
        N.push({ text: b.text, ctx: true, oPos: O.length - 1 });
      } else if (b.t === '-') O.push(b.text);
      else if (b.t === '+') N.push({ text: b.text, ctx: false, oPos: -1 });
    }
    if (O.length === 0) {
      const at = Math.min(h.A + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...N.map((n) => n.text));
      if (atEnd) f.fin = !backslashAfterLastCtxPlus(h);
      d += N.length;
    } else {
      const tier = findTier(O, f.lines, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occs = occurrences(O, f.lines, tier);
      const target = h.A - 1 + d;
      let best = occs[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occs) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const toEnd = best + O.length === f.lines.length;
      f.lines = replaceLines(f.lines, best, O, N, tier);
      if (toEnd) f.fin = !backslashAfterLastCtxPlus(h);
      d += N.length - O.length;
    }
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld ?? null;
    const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew ?? null;
    return (tree: Tree): void => {
      if (oldP === null && newP === null) return;
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (oldP === null || sec.isNew) {
        if (newP === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        let lastPlus: { hunk: UHunk; idx: number } | null = null;
        for (const h of sec.hunks) {
          for (let j = 0; j < h.body.length; j++) {
            if (h.body[j]!.t === '+') lastPlus = { hunk: h, idx: j };
          }
        }
        const plus = sec.hunks.flatMap((h) => h.body.filter((b) => b.t === '+').map((b) => b.text));
        let fin = true;
        if (lastPlus !== null) {
          const nx = lastPlus.hunk.body[lastPlus.idx + 1];
          if (nx !== undefined && nx.t === '\\') fin = false;
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
        return;
      }
      if (newP === null || sec.isDel) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        tree.moves.push([oldP, newP]);
        return;
      }
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP));
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (eq < 0) {
        if (lines[j]!.trimEnd() === '=======') eq = j;
      } else if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const tier = findTier(oldLines, f.lines, strict);
      if (tier < 0) throw new Fail('no-match', p);
      const occs = occurrences(oldLines, f.lines, tier);
      if (occs.length > 1) throw new Fail('ambiguous', p);
      const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oPos: -1 }));
      f.lines = replaceLines(f.lines, occs[0]!, oldLines, N, tier);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  body: UBody[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      const p = path;
      const fl = fileLines;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      const closeChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      let firstLine = true;
      for (const r of raw) {
        const l = r.text;
        if (firstLine && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          closeChunk();
          const a = l.slice(2).trim();
          chunk = { anchor: a === '' ? null : a, body: [], eof: false };
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.num}`);
          chunk.eof = true;
          closeChunk();
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) chunk = { anchor: null, body: [], eof: false };
          chunk.body.push({ t: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        let f = splitFile(cur);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            let found = -1;
            const maxT = strict ? 0 : 2;
            for (let t = 0; t <= maxT && found < 0; t++) {
              for (let k = cursor; k < f.lines.length; k++) {
                if (eqAt(t, ch.anchor, f.lines[k]!)) {
                  found = k;
                  break;
                }
              }
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          const O: string[] = [];
          const N: NLine[] = [];
          for (const b of ch.body) {
            if (b.t === ' ') {
              O.push(b.text);
              N.push({ text: b.text, ctx: true, oPos: O.length - 1 });
            } else if (b.t === '-') O.push(b.text);
            else if (b.t === '+') N.push({ text: b.text, ctx: false, oPos: -1 });
          }
          if (O.length === 0) {
            const at = ch.eof ? f.lines.length : cursor;
            f.lines.splice(at, 0, ...N.map((n) => n.text));
            cursor = at + N.length;
          } else {
            const tier = findTier(O, f.lines, strict, cursor);
            if (tier < 0) throw new Fail('no-match', p);
            let occs = occurrences(O, f.lines, tier, cursor);
            if (ch.eof) occs = occs.filter((pos) => pos + O.length === f.lines.length);
            if (occs.length === 0) throw new Fail('no-match', p);
            const pos = occs[0]!;
            f.lines = replaceLines(f.lines, pos, O, N, tier);
            cursor = pos + N.length;
          }
        }
        const out = joinFile(f);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, out);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  const seenMove = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const mk = `${oldP}\0${newP}`;
    if (seenMove.has(mk)) continue;
    seenMove.add(mk);
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
