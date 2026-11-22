// mend: one patch tool for every AI edit format.
//
// Written from SPEC.md (version 1) in the kit starter. Node 22, standard
// library only. Run as: node main.ts [options] [PATCH]
//
// A patch arrives in one of four formats (unified diff, SEARCH/REPLACE,
// V4A, JSON edits). Each edit names old lines that are found in the target
// file at the first of three matching tiers, and every edit is applied to
// the tree or none of them is written.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

/** Raised to stop with an exit-2 line, nothing else written. */
class PatchFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Raised by one edit to report its failure code and the path it concerns. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimEndWs = (s: string): string => s.trimEnd();

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no backslash, and none of its segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file's lines, its line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  tail: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', tail: false };
  const first = text.indexOf('\n');
  const br: '\r\n' | '\n' = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const tail = text.endsWith(br);
  const parts = text.split(br);
  if (tail) parts.pop();
  return { lines: parts, br, tail };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.tail ? d.br : '');
}

/** The working tree: original contents read lazily from disk, pending changes in memory. */
class WorkTree {
  private base = new Map<string, string | null>();
  private pending = new Map<string, string | null>();
  private moved: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p) as string | null;
  }

  current(p: string): string | null {
    return this.pending.has(p) ? (this.pending.get(p) as string | null) : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.pending.set(p, text);
  }

  noteMove(from: string, to: string): void {
    this.moved.push([from, to]);
  }

  snapshot(): { pending: Map<string, string | null>; moved: Array<[string, string]> } {
    return { pending: new Map(this.pending), moved: [...this.moved] };
  }

  restore(s: { pending: Map<string, string | null>; moved: Array<[string, string]> }): void {
    this.pending = s.pending;
    this.moved = s.moved;
  }

  /** Rows for exit 0, sorted by path bytes; a recorded move prints as one R row sorting by the new path. */
  changeRows(): string[] {
    const rows: Array<{ key: string; line: string }> = [];
    const hiddenD = new Set<string>();
    const hiddenA = new Set<string>();
    for (const [from, to] of this.moved) {
      if (this.original(from) !== null && this.current(from) === null && this.original(to) === null && this.current(to) !== null) {
        rows.push({ key: to, line: `R ${from} -> ${to}` });
        hiddenD.add(from);
        hiddenA.add(to);
      }
    }
    for (const p of this.pending.keys()) {
      const was = this.original(p);
      const now = this.pending.get(p) as string | null;
      if (was === now) continue;
      if (was === null) {
        if (!hiddenA.has(p)) rows.push({ key: p, line: `A ${p}` });
      } else if (now === null) {
        if (!hiddenD.has(p)) rows.push({ key: p, line: `D ${p}` });
      } else {
        rows.push({ key: p, line: `M ${p}` });
      }
    }
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
    return rows.map((r) => r.line);
  }

  flush(): void {
    for (const p of this.pending.keys()) {
      const was = this.original(p);
      const now = this.pending.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
}

/** A line as seen at one matching tier: 0 exact, 1 trailing spaces/tabs stripped, 2 both sides stripped. */
function tierText(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** Positions where `old` matches `lines` at one tier, starting at `from`. */
function matchAt(lines: string[], old: string[], tier: number, from = 0): number[] {
  const hits: number[] = [];
  if (old.length === 0) return hits;
  for (let i = from; i + old.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < old.length; j++) {
      if (tierText(lines[i + j] as string, tier) !== tierText(old[j] as string, tier)) {
        good = false;
        break;
      }
    }
    if (good) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2) at which `old` occurs, with its positions; strict means tier 0 only. */
function firstTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; hits: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const hits = matchAt(lines, old, t, from);
    if (hits.length > 0) return { tier: t, hits };
  }
  return null;
}

/** A chunk's old and new lines, with each new line's old index when it is a context line, -1 when added. */
interface ChunkShape {
  oldLines: string[];
  newLines: string[];
  contextAt: number[];
}

/**
 * The replacement lines for a match at `at`: context lines are the file's
 * own matched lines; at tier 2 every other line is re-indented from the
 * patch's first old line to the file's first matched line.
 */
function buildNew(fileLines: string[], at: number, shape: ChunkShape, tier: number): string[] {
  const out: string[] = [];
  const fileLead = fileLines.length > 0 ? leadingOf(fileLines[at] as string) : '';
  const patchLead = shape.oldLines.length > 0 ? leadingOf(shape.oldLines[0] as string) : '';
  for (let j = 0; j < shape.newLines.length; j++) {
    const cj = shape.contextAt[j] as number;
    if (cj >= 0) {
      out.push(fileLines[at + cj] as string);
    } else {
      let line = shape.newLines[j] as string;
      if (tier === 2 && line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(patchLead)) {
        line = fileLead + line.slice(patchLead.length);
      }
      out.push(line);
    }
  }
  return out;
}

type BodyItem = { kind: ' ' | '-' | '+' | '\\'; text: string };

/** Turn a body (context, old, new, backslash lines) into its old/new shape. */
function shapeOf(items: BodyItem[]): ChunkShape {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const contextAt: number[] = [];
  for (const it of items) {
    if (it.kind === ' ') {
      contextAt.push(oldLines.length);
      oldLines.push(it.text);
      newLines.push(it.text);
    } else if (it.kind === '-') {
      oldLines.push(it.text);
    } else if (it.kind === '+') {
      contextAt.push(-1);
      newLines.push(it.text);
    }
  }
  return { oldLines, newLines, contextAt };
}

/** True when a backslash line follows the chunk's last context or added line: the result ends with no line break. */
function endsNoBreak(items: BodyItem[]): boolean {
  let last = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.kind === ' ' || items[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return items[last + 1]?.kind === '\\';
}

/** Drop trailing context lines with empty or whitespace-only text: they are not part of a chunk. */
function stripTrailingEmpty(items: BodyItem[]): void {
  while (items.length > 0) {
    const last = items[items.length - 1] as BodyItem;
    if (last.kind === ' ' && last.text.trim() === '') items.pop();
    else break;
  }
}

type Edit = (tree: WorkTree) => void;

/** Argument parsing: --format=NAME, --check, --strict, one optional PATCH, -- ends the options. */
interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !(FORMATS as readonly string[]).includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string) };
}

/** Format detection, first match wins: v4a, then JSON, then SEARCH/REPLACE, then unified. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart();
  if (head[0] === '[' || head[0] === '{') return 'json';
  if (lines.some((l) => trimEndWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------- unified diff ---------------- */

interface UnifiedHunk {
  start: number; // A, the old start line (1-based)
  items: BodyItem[];
}

interface UnifiedSection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  created: boolean;
  deleted: boolean;
  hunks: UnifiedHunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed; /dev/null means none; a leading a/ or b/ removed. */
function patchPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** Parse `diff --git a/<X> b/<Y>`; null when the line is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  return m === null ? null : [m[1] as string, m[2] as string];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The old start line of a hunk header; null when the header is malformed. */
function hunkStart(line: string): number | null {
  const m = HUNK_HEAD.exec(line);
  return m === null ? null : Number(m[1]);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): UnifiedSection => ({ created: false, deleted: false, hunks: [] });
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const g = diffGitPaths(line);
      if (g === null) throw new PatchFault(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = g[0];
      cur.gitNew = g[1];
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = patchPath(line.slice(4));
        cur.pairNew = patchPath((lines[i + 1] as string).slice(4));
        i += 2;
        continue;
      }
      cur = fresh();
      cur.pairOld = patchPath(line.slice(4));
      cur.pairNew = patchPath((lines[i + 1] as string).slice(4));
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new PatchFault(`error: parse ${i + 1}`);
      const start = hunkStart(line);
      if (start === null) throw new PatchFault(`error: parse ${i + 1}`);
      i += 1;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const b = lines[i] as string;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          items.push({ kind: b === '' ? ' ' : (b[0] as BodyItem['kind']), text: b === '' ? '' : b.slice(1) });
          i += 1;
        } else break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1] as BodyItem;
        if (last.kind === ' ' && last.text === '') items.pop();
        else break;
      }
      cur.hunks.push({ start, items });
      inHeader = false;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('--- ')) throw new PatchFault(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (cur.pairNew === undefined) cur.pairNew = patchPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.created = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deleted = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => {
    const oldP = firstDefined(s.pairOld, s.renOld, s.gitOld) ?? null;
    const newP = firstDefined(s.pairNew, s.renNew, s.gitNew) ?? null;
    return (tree: WorkTree) => applyUnified(tree, s, oldP, newP, strict);
  });
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

function applyUnified(tree: WorkTree, s: UnifiedSection, oldP: string | null, newP: string | null, strict: boolean): void {
  const isCreate = oldP === null || s.created;
  const isDelete = newP === null || s.deleted;
  if (isCreate) {
    if (newP === null) throw new EditFault('unsafe', '');
    if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
    if (tree.current(newP) !== null) throw new EditFault('exists', newP);
    const added: string[] = [];
    let lastPlus: { items: BodyItem[]; idx: number } | null = null;
    for (const h of s.hunks) {
      for (let k = 0; k < h.items.length; k++) {
        if (h.items[k]!.kind === '+') {
          added.push(h.items[k]!.text);
          lastPlus = { items: h.items, idx: k };
        }
      }
    }
    const noBreak = lastPlus !== null && lastPlus.items[lastPlus.idx + 1]?.kind === '\\';
    tree.set(newP, added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n'));
    return;
  }
  if (isDelete) {
    if (oldP === null) throw new EditFault('unsafe', '');
    if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
    if (tree.current(oldP) === null) throw new EditFault('missing', oldP);
    tree.set(oldP, null);
    return;
  }
  // Change, or a move when the two paths differ.
  if (oldP === null || newP === null) throw new EditFault('unsafe', '');
  if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
  const isMove = newP !== oldP;
  if (isMove && !isSafePath(newP)) throw new EditFault('unsafe', newP);
  const before = tree.current(oldP);
  if (before === null) throw new EditFault('missing', oldP);
  if (isMove && tree.current(newP) !== null) throw new EditFault('exists', newP);
  let doc = readDoc(before);
  let d = 0;
  for (const h of s.hunks) {
    const shape = shapeOf(h.items);
    if (shape.oldLines.length > 0) {
      const found = firstTier(doc.lines, shape.oldLines, strict);
      if (found === null) throw new EditFault('no-match', oldP);
      const target = h.start - 1 + d;
      let at = found.hits[0] as number;
      for (const p of found.hits) {
        if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      }
      const replaced = buildNew(doc.lines, at, shape, found.tier);
      const lines = [...doc.lines.slice(0, at), ...replaced, ...doc.lines.slice(at + shape.oldLines.length)];
      let tail = doc.tail;
      if (at + shape.oldLines.length === doc.lines.length) tail = !endsNoBreak(h.items);
      doc = { lines, br: doc.br, tail };
      d += shape.newLines.length - shape.oldLines.length;
    } else {
      const idx = Math.min(h.start + d, doc.lines.length);
      const lines = [...doc.lines.slice(0, idx), ...shape.newLines, ...doc.lines.slice(idx)];
      let tail = doc.tail;
      if (idx === doc.lines.length) tail = !endsNoBreak(h.items);
      doc = { lines, br: doc.br, tail };
      d += shape.newLines.length;
    }
  }
  const out = writeDoc(doc);
  if (isMove) {
    tree.set(newP, out);
    tree.set(oldP, null);
    tree.noteMove(oldP, newP);
  } else {
    tree.set(oldP, out);
  }
}

/* ---------------- SEARCH / REPLACE ---------------- */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let floor = 0; // index just past the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as string;
    if (trimEndWs(l) === '<<<<<<< SEARCH') {
      const searchIdx = i;
      // The path is the nearest line before SEARCH, after the previous block,
      // that is not blank and, trimmed, does not start with three backticks.
      let path: string | null = null;
      for (let k = searchIdx - 1; k >= floor; k--) {
        const cand = lines[k] as string;
        if (isBlank(cand)) continue;
        if (cand.trim().startsWith('```')) continue;
        path = cand.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new PatchFault(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      i += 1;
      const oldLines: string[] = [];
      while (i < lines.length && trimEndWs(lines[i] as string) !== '=======' && trimEndWs(lines[i] as string) !== '>>>>>>> REPLACE') {
        oldLines.push(lines[i] as string);
        i += 1;
      }
      if (i >= lines.length || trimEndWs(lines[i] as string) !== '=======') throw new PatchFault(`error: parse ${searchIdx + 1}`);
      i += 1;
      const newLines: string[] = [];
      while (i < lines.length && trimEndWs(lines[i] as string) !== '>>>>>>> REPLACE') {
        newLines.push(lines[i] as string);
        i += 1;
      }
      if (i >= lines.length) throw new PatchFault(`error: parse ${searchIdx + 1}`);
      i += 1;
      blocks.push({ path, oldLines, newLines });
      prevPath = path;
      floor = i;
      continue;
    }
    i += 1;
  }
  return blocks.map((b) => (tree: WorkTree) => applySearchReplace(tree, b, strict));
}

function applySearchReplace(tree: WorkTree, b: SrBlock, strict: boolean): void {
  if (!isSafePath(b.path)) throw new EditFault('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.current(b.path) !== null) throw new EditFault('exists', b.path);
    tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return;
  }
  const before = tree.current(b.path);
  if (before === null) throw new EditFault('missing', b.path);
  const doc = readDoc(before);
  const found = firstTier(doc.lines, b.oldLines, strict);
  if (found === null) throw new EditFault('no-match', b.path);
  if (found.hits.length > 1) throw new EditFault('ambiguous', b.path);
  const at = found.hits[0] as number;
  const replaced = buildNew(doc.lines, at, { oldLines: b.oldLines, newLines: b.newLines, contextAt: b.newLines.map(() => -1) }, found.tier);
  const lines = [...doc.lines.slice(0, at), ...replaced, ...doc.lines.slice(at + b.oldLines.length)];
  // A changed file keeps its own break and its final break as before.
  tree.set(b.path, writeDoc({ lines, br: doc.br, tail: doc.tail }));
}

/* ---------------- V4A ---------------- */

interface V4aChunk {
  anchor: string | null;
  endOfFile: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:');
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new PatchFault(`error: parse ${first + 1}`);
  let end = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      end = k;
      break;
    }
  }
  if (end < 0 || lines[end]!.trim() !== '*** End Patch') throw new PatchFault(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < end) {
    const l = lines[i] as string;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const sec: V4aSection = { kind: 'add', path: l.slice('*** Add File:'.length).trim(), moveTo: null, addLines: [], chunks: [] };
      i += 1;
      while (i < end && !isV4aSectionStart(lines[i] as string)) {
        const b = lines[i] as string;
        if (b.startsWith('+')) sec.addLines.push(b.slice(1));
        else if (b === '') sec.addLines.push('');
        else throw new PatchFault(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.addLines.length > 0) {
        const last = sec.addLines[sec.addLines.length - 1] as string;
        if (last === '' || last.trim() === '') sec.addLines.pop();
        else break;
      }
      sections.push(sec);
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      sections.push({ kind: 'delete', path: l.slice('*** Delete File:'.length).trim(), moveTo: null, addLines: [], chunks: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const updateIdx = i;
      const sec: V4aSection = { kind: 'update', path: l.slice('*** Update File:'.length).trim(), moveTo: null, addLines: [], chunks: [] };
      i += 1;
      if (i < end && (lines[i] as string).startsWith('*** Move to:')) {
        sec.moveTo = (lines[i] as string).slice('*** Move to:'.length).trim();
        i += 1;
      }
      let cur: V4aChunk | null = null;
      const openChunk = (anchor: string | null): void => {
        cur = { anchor, endOfFile: false, items: [] };
        sec.chunks.push(cur);
      };
      while (i < end && !isV4aSectionStart(lines[i] as string)) {
        const b = lines[i] as string;
        if (b.startsWith('@@')) {
          const anchorText = b.slice(2).trim();
          openChunk(anchorText === '' ? null : anchorText);
          i += 1;
          continue;
        }
        if (trimEndWs(b) === '*** End of File') {
          if (cur === null) openChunk(null);
          (cur as V4aChunk).endOfFile = true;
          i += 1;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) openChunk(null);
          (cur as V4aChunk).items.push({ kind: b === '' ? ' ' : (b[0] as BodyItem['kind']), text: b === '' ? '' : b.slice(1) });
          i += 1;
          continue;
        }
        throw new PatchFault(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it: drop trailing
      // context lines with empty or whitespace-only text from the last chunk.
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk !== undefined) stripTrailingEmpty(lastChunk.items);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new PatchFault(`error: parse ${updateIdx + 1}`);
      sections.push(sec);
      continue;
    }
    throw new PatchFault(`error: parse ${i + 1}`);
  }
  return sections.map((s) => (tree: WorkTree) => applyV4a(tree, s, strict));
}

function applyV4a(tree: WorkTree, s: V4aSection, strict: boolean): void {
  if (!isSafePath(s.path)) throw new EditFault('unsafe', s.path);
  if (s.kind === 'add') {
    if (tree.current(s.path) !== null) throw new EditFault('exists', s.path);
    tree.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'delete') {
    if (tree.current(s.path) === null) throw new EditFault('missing', s.path);
    tree.set(s.path, null);
    return;
  }
  // Update, with an optional move.
  if (s.moveTo !== null && !isSafePath(s.moveTo)) throw new EditFault('unsafe', s.moveTo);
  const before = tree.current(s.path);
  if (before === null) throw new EditFault('missing', s.path);
  if (s.moveTo !== null && tree.current(s.moveTo) !== null) throw new EditFault('exists', s.moveTo);
  let doc = readDoc(before);
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      const found = firstTier(doc.lines, [chunk.anchor], strict, cursor);
      if (found === null) throw new EditFault('no-match', s.path);
      cursor = (found.hits[0] as number) + 1;
    }
    const shape = shapeOf(chunk.items);
    if (shape.oldLines.length > 0) {
      const found = firstTier(doc.lines, shape.oldLines, strict, cursor);
      if (found === null) throw new EditFault('no-match', s.path);
      let at = -1;
      for (const p of found.hits) {
        if (chunk.endOfFile && p + shape.oldLines.length !== doc.lines.length) continue;
        at = p;
        break;
      }
      if (at < 0) throw new EditFault('no-match', s.path);
      const replaced = buildNew(doc.lines, at, shape, found.tier);
      const lines = [...doc.lines.slice(0, at), ...replaced, ...doc.lines.slice(at + shape.oldLines.length)];
      doc = { lines, br: doc.br, tail: doc.tail };
      cursor = at + replaced.length;
    } else {
      const idx = chunk.endOfFile ? doc.lines.length : cursor;
      const lines = [...doc.lines.slice(0, idx), ...shape.newLines, ...doc.lines.slice(idx)];
      doc = { lines, br: doc.br, tail: doc.tail };
      cursor = idx + shape.newLines.length;
    }
  }
  const out = writeDoc(doc);
  if (s.moveTo !== null) {
    tree.set(s.moveTo, out);
    tree.set(s.path, null);
    tree.noteMove(s.path, s.moveTo);
  } else {
    tree.set(s.path, out);
  }
}

/* ---------------- JSON ---------------- */

type JsonEdit = { path: string; command: string; fileText?: string; oldStr?: string; newStr?: string; insertLine?: number };

/** Parse one JSON edit object; null when it is not a well-formed edit object. */
function parseJsonEditObject(value: unknown): JsonEdit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  const e: JsonEdit = { path: o.path, command: o.command };
  if (e.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    e.fileText = o.file_text;
  } else if (e.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    e.oldStr = o.old_str;
    e.newStr = o.new_str === undefined ? '' : o.new_str;
  } else if (e.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    e.insertLine = o.insert_line;
    e.newStr = o.new_str;
  } else {
    return null;
  }
  return e;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchFault('error: parse 1');
  const edits: JsonEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new PatchFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new PatchFault(`error: parse ${first + 1}`);
    for (const item of value) {
      const e = parseJsonEditObject(item);
      if (e === null) throw new PatchFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
  } else {
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k] as string;
      if (isBlank(l)) continue;
      let value: unknown;
      try {
        value = JSON.parse(l);
      } catch {
        throw new PatchFault(`error: parse ${k + 1}`);
      }
      const e = parseJsonEditObject(value);
      if (e === null) throw new PatchFault(`error: parse ${k + 1}`);
      edits.push(e);
    }
  }
  return edits.map((e) => (tree: WorkTree) => applyJson(tree, e));
}

function applyJson(tree: WorkTree, e: JsonEdit): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  if (e.command === 'create') {
    if (tree.current(e.path) !== null) throw new EditFault('exists', e.path);
    tree.set(e.path, e.fileText as string);
    return;
  }
  const before = tree.current(e.path);
  if (before === null) throw new EditFault('missing', e.path);
  if (e.command === 'str_replace') {
    const oldStr = e.oldStr as string;
    const newStr = e.newStr as string;
    const doc = readDoc(before);
    let text: string;
    let toCrLf = false;
    if (doc.br === '\r\n') {
      text = before.replace(/\r\n/g, '\n');
      toCrLf = true;
    } else {
      text = before;
    }
    const first = text.indexOf(oldStr);
    if (first < 0) throw new EditFault('no-match', e.path);
    if (text.indexOf(oldStr, first + 1) >= 0) throw new EditFault('ambiguous', e.path);
    let out = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
    if (toCrLf) out = out.replace(/\n/g, '\r\n');
    tree.set(e.path, out);
    return;
  }
  // insert
  const insertLine = e.insertLine as number;
  const doc = readDoc(before);
  if (insertLine < 0 || insertLine > doc.lines.length) throw new EditFault('no-match', e.path);
  const added = splitPatch(e.newStr as string);
  const lines = [...doc.lines.slice(0, insertLine), ...added, ...doc.lines.slice(insertLine)];
  tree.set(e.path, writeDoc({ lines, br: doc.br, tail: doc.tail }));
}

/* ---------------- run ---------------- */

function parsePatch(text: string, format: string, strict: boolean): Edit[] {
  const lines = splitPatch(text);
  const want = format === 'auto' ? detectFormat(lines) : format;
  if (want === null) throw new PatchFault('error: format');
  let edits: Edit[];
  if (want === 'unified') edits = parseUnified(lines, strict);
  else if (want === 'search-replace') edits = parseSearchReplace(lines, strict);
  else if (want === 'v4a') edits = parseV4a(lines, strict);
  else edits = parseJson(text, lines);
  if (edits.length === 0) throw new PatchFault('error: parse 1');
  return edits;
}

function execute(argv: string[]): { code: number; out: string[] } {
  const cli = parseArgs(argv);
  if (cli === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  if (cli.patch !== null) {
    try {
      text = readFileSync(cli.patch, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  }
  let edits: Edit[];
  try {
    edits = parsePatch(text, cli.format, cli.strict);
  } catch (e) {
    if (e instanceof PatchFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const failures: Array<{ code: string; path: string }> = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof EditFault) {
        tree.restore(snap);
        failures.push({ code: e.code, path: e.path });
        continue;
      }
      throw e;
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  const rows = tree.changeRows();
  if (!cli.check) tree.flush();
  const out = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}

// Trial handover (kept as the kit has it): when MAKEFUN_ENV_URL is set, the
// entry runs as a trial worker instead of as a command-line tool.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = execute(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
