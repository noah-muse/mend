// mend: applies AI-written edits (unified diff, SEARCH/REPLACE, V4A, JSON tool calls) to a tree of text files.
// Implements SPEC.md (version 1). Node 22, standard library only.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Outcome types

type Exit = { code: number; out: string[] };

class Fatal extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

const parseFail = (n: number): never => {
  throw new Fatal(`error: parse ${n}`);
};

type FailCode = 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';

class EditFailure extends Error {
  code: FailCode;
  path: string;
  constructor(code: FailCode, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const fail = (code: FailCode, path: string): never => {
  throw new EditFailure(code, path);
};

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

/** Lines of a patch: split at LF, one trailing CR dropped from each, no empty piece after a final LF. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const isBlank = (s: string): boolean => /^\s*$/.test(s);
const stripRight = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A file viewed as lines, with its break style and whether it ends with a break. */
interface Doc {
  lines: string[];
  brk: string;
  eol: boolean;
}

function toDoc(text: string): Doc {
  const lf = text.indexOf('\n');
  const brk = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], brk, eol: false };
  const lines = text.split(brk);
  let eol = false;
  if (text.endsWith(brk)) {
    lines.pop();
    eol = true;
  }
  return { lines, brk, eol };
}

function fromDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.brk) + (d.eol ? d.brk : '');
}

/** A file an edit creates: LF breaks, a final break when it has lines (unless told otherwise). */
function newFileText(lines: string[], eol = true): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (eol ? '\n' : '');
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------------------------------------------
// Line matching (section 5)

const TIERS: Array<(s: string) => string> = [(s) => s, stripRight, stripBoth];

interface Found {
  tier: number;
  positions: number[];
}

/**
 * Finds `old` in `lines` at the first tier with at least one occurrence that `accept` allows.
 * Returns null when no tier has one.
 */
function locate(lines: string[], old: string[], strict: boolean, accept: (pos: number) => boolean = () => true): Found | null {
  const tierCount = strict ? 1 : 3;
  for (let tier = 0; tier < tierCount; tier += 1) {
    const norm = TIERS[tier];
    const want = old.map(norm);
    const have = tier === 0 ? lines : lines.map(norm);
    const positions: number[] = [];
    for (let pos = 0; pos + want.length <= have.length; pos += 1) {
      if (!accept(pos)) continue;
      let ok = true;
      for (let j = 0; j < want.length; j += 1) {
        if (have[pos + j] !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(pos);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: context (in O and N), old only, or new only. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noEol?: boolean;
}

/** O and N of a body, in body order. */
const oldSide = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '+').map((b) => b.text);
const newSide = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '-').map((b) => b.text);

/**
 * The lines that replace the matched lines at `pos`: context lines come from the file, the rest from the patch,
 * re-indented at tier 2.
 */
function replacement(fileLines: string[], pos: number, tier: number, body: BodyLine[]): string[] {
  const old = oldSide(body);
  let from = '';
  let to = '';
  if (tier === 2 && old.length > 0) {
    from = leadingWs(old[0]);
    to = leadingWs(fileLines[pos]);
  }
  const out: string[] = [];
  let j = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(fileLines[pos + j]);
      j += 1;
    } else if (b.kind === '-') {
      j += 1;
    } else if (tier === 2 && !isBlank(b.text) && b.text.startsWith(from)) {
      out.push(to + b.text.slice(from.length));
    } else {
      out.push(b.text);
    }
  }
  return out;
}

/** The first index at or after `start` whose line equals `anchor` at the first tier that has one, or -1. */
function findAnchor(lines: string[], anchor: string, start: number, strict: boolean): number {
  const tierCount = strict ? 1 : 3;
  for (let tier = 0; tier < tierCount; tier += 1) {
    const norm = TIERS[tier];
    const want = norm(anchor);
    for (let i = start; i < lines.length; i += 1) if (norm(lines[i]) === want) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// The tree: the files on disk with every edit applied so far layered over them

class Tree {
  private overlay = new Map<string, string | null>();
  private original = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  private disk(p: string): string | null {
    if (!this.original.has(p)) {
      let text: string | null = null;
      try {
        if (existsSync(p) && statSync(p).isFile()) text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      this.original.set(p, text);
    }
    return this.original.get(p)!;
  }

  read(p: string): string | null {
    if (this.overlay.has(p)) return this.overlay.get(p)!;
    return this.disk(p);
  }

  exists(p: string): boolean {
    return this.read(p) !== null;
  }

  /** A staged set of changes for one edit, committed only when the edit succeeds. */
  stage(): Stage {
    return new Stage(this);
  }

  commit(changes: Map<string, string | null>): void {
    for (const [p, v] of changes) {
      this.disk(p);
      this.overlay.set(p, v);
    }
  }

  /** Every path whose state differs from disk, with its status line, in byte order. */
  report(): Array<{ key: string; line: string; path: string; after: string | null }> {
    const rows = new Map<string, { key: string; line: string; path: string; after: string | null }>();
    for (const [p, after] of this.overlay) {
      const before = this.original.get(p) ?? null;
      if (before === after) continue;
      const tag = before === null ? 'A' : after === null ? 'D' : 'M';
      rows.set(p, { key: p, line: `${tag} ${p}`, path: p, after });
    }
    for (const [from, to] of this.moves) {
      const a = rows.get(from);
      const b = rows.get(to);
      if (a && b && a.line.startsWith('D ') && b.line.startsWith('A ')) {
        rows.delete(from);
        b.line = `R ${from} -> ${to}`;
      }
    }
    const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
    // R lines sort by their new path, which is the key their row already carries.
    return [...rows.values()].sort((x, y) => Buffer.compare(enc(x.key), enc(y.key)));
  }

  /** Every path to write (content) or delete (null). */
  pending(): Array<[string, string | null]> {
    const out: Array<[string, string | null]> = [];
    for (const [p, after] of this.overlay) if ((this.original.get(p) ?? null) !== after) out.push([p, after]);
    return out;
  }
}

class Stage {
  changes = new Map<string, string | null>();
  private tree: Tree;
  constructor(tree: Tree) {
    this.tree = tree;
  }
  read(p: string): string | null {
    if (this.changes.has(p)) return this.changes.get(p)!;
    return this.tree.read(p);
  }
  exists(p: string): boolean {
    return this.read(p) !== null;
  }
  write(p: string, text: string): void {
    this.changes.set(p, text);
  }
  remove(p: string): void {
    this.changes.set(p, null);
  }
}

/** One edit of a patch: applying it either stages its changes or throws an EditFailure. */
interface Edit {
  apply(s: Stage, strict: boolean): void;
  /** Set for a move, so a successful one can be reported as R. */
  move?: [string, string];
}

function requireSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafePath(p)) fail('unsafe', p);
}

// ---------------------------------------------------------------------------------------------------------------
// Format detection (section 4)

type Format = 'unified' | 'search-replace' | 'v4a' | 'json';

function detect(lines: string[]): Format | null {
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (section 6)

interface Hunk {
  start: number; // A
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  minus?: string | null; // null: /dev/null
  plus?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function headerPath(rest: string): string | null {
  const tab = rest.indexOf('\t');
  let p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function splitGitPaths(rest: string): [string, string] | null {
  if (!rest.startsWith('a/')) return null;
  const candidates: Array<[string, string]> = [];
  let at = rest.indexOf(' b/');
  while (at >= 0) {
    const x = rest.slice(2, at);
    const y = rest.slice(at + 3);
    if (x !== '' && y !== '') candidates.push([x, y]);
    at = rest.indexOf(' b/', at + 1);
  }
  if (candidates.length === 0) return null;
  return candidates.find(([x, y]) => x === y) ?? candidates[0];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const pairAt = (i: number): boolean => lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
  const fresh = (): Section => ({ newFile: false, deletedFile: false, hasPair: false, hunks: [] });

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const paths = splitGitPaths(line.slice('diff --git '.length));
      if (paths === null) parseFail(i + 1);
      cur = fresh();
      cur.gitOld = paths![0];
      cur.gitNew = paths![1];
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (!(cur !== null && inHeader && !cur.hasPair)) {
        cur = fresh();
        sections.push(cur);
        inHeader = true;
      }
      cur.minus = headerPath(line.slice(4));
      cur.plus = headerPath(lines[i + 1].slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null || cur === null) parseFail(i + 1);
      const hunk: Hunk = { start: Number(m![1]), body: [] };
      let j = i + 1;
      const raw: string[] = [];
      while (j < lines.length) {
        const l = lines[j];
        if (l.startsWith('diff --git ') || pairAt(j)) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      for (const l of raw) {
        if (l === '') hunk.body.push({ kind: ' ', text: '' });
        else if (l[0] === '\\') {
          if (hunk.body.length > 0) hunk.body[hunk.body.length - 1].noEol = true;
        } else hunk.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
      }
      cur!.hunks.push(hunk);
      inHeader = false;
      i += 1 + raw.length;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) parseFail(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections.map(sectionEdit);
}

function sectionEdit(s: Section): Edit {
  const oldPath = s.minus !== undefined ? s.minus : (s.renameFrom ?? s.gitOld ?? null);
  const newPath = s.plus !== undefined ? s.plus : (s.renameTo ?? s.gitNew ?? null);
  const creating = (s.minus === null) || s.newFile;
  const deleting = !creating && ((s.plus === null) || s.deletedFile);

  if (creating) {
    const path = newPath ?? oldPath ?? '';
    return {
      apply(st) {
        requireSafe(path);
        if (st.exists(path)) fail('exists', path);
        const added: BodyLine[] = s.hunks.flatMap((h) => h.body.filter((b) => b.kind === '+'));
        const eol = added.length === 0 || !added[added.length - 1].noEol;
        st.write(path, newFileText(added.map((b) => b.text), eol));
      },
    };
  }
  if (deleting) {
    const path = oldPath ?? newPath ?? '';
    return {
      apply(st) {
        requireSafe(path);
        if (!st.exists(path)) fail('missing', path);
        st.remove(path);
      },
    };
  }
  const from = oldPath ?? '';
  const to = newPath ?? from;
  const moving = from !== to;
  const edit: Edit = {
    apply(st, strict) {
      requireSafe(from);
      if (moving) requireSafe(to);
      const text = st.read(from);
      if (text === null) fail('missing', from);
      if (moving && st.exists(to)) fail('exists', to);
      const doc = toDoc(text!);
      let d = 0;
      for (const h of s.hunks) {
        const old = oldSide(h.body);
        const neu = newSide(h.body);
        const lastNew = [...h.body].reverse().find((b) => b.kind !== '-');
        const endsWithBreak = !(lastNew?.noEol ?? false);
        if (old.length === 0) {
          const at = Math.max(0, Math.min(h.start + d, doc.lines.length));
          const atEnd = at === doc.lines.length;
          doc.lines.splice(at, 0, ...neu);
          if (atEnd) doc.eol = endsWithBreak;
        } else {
          const found = locate(doc.lines, old, strict);
          if (found === null) fail('no-match', from);
          const target = h.start - 1 + d;
          let best = found!.positions[0];
          for (const p of found!.positions) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
          const toEnd = best + old.length === doc.lines.length;
          const rep = replacement(doc.lines, best, found!.tier, h.body);
          doc.lines.splice(best, old.length, ...rep);
          if (toEnd) doc.eol = endsWithBreak;
        }
        d += neu.length - old.length;
      }
      if (moving) {
        st.remove(from);
        st.write(to, fromDoc(doc));
      } else st.write(from, fromDoc(doc));
    },
  };
  if (moving) edit.move = [from, to];
  return edit;
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let regionStart = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= regionStart; k -= 1) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) parseFail(i + 1);
    let sep = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k].trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let k = sep + 1; k < lines.length; k += 1) {
        if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (end < 0) parseFail(i + 1);
    edits.push(blockEdit(path!, lines.slice(i + 1, sep), lines.slice(sep + 1, end)));
    prevPath = path;
    regionStart = end + 1;
    i = end + 1;
  }
  return edits;
}

function blockEdit(path: string, search: string[], replace: string[]): Edit {
  return {
    apply(st, strict) {
      requireSafe(path);
      if (search.length === 0) {
        if (st.exists(path)) fail('exists', path);
        st.write(path, newFileText(replace));
        return;
      }
      const text = st.read(path);
      if (text === null) fail('missing', path);
      const doc = toDoc(text!);
      const found = locate(doc.lines, search, strict);
      if (found === null) fail('no-match', path);
      if (found!.positions.length > 1) fail('ambiguous', path);
      const pos = found!.positions[0];
      const body: BodyLine[] = [
        ...search.map((t): BodyLine => ({ kind: '-', text: t })),
        ...replace.map((t): BodyLine => ({ kind: '+', text: t })),
      ];
      doc.lines.splice(pos, search.length, ...replacement(doc.lines, pos, found!.tier, body));
      st.write(path, fromDoc(doc));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const ADD = '*** Add File: ';
const DEL = '*** Delete File: ';
const UPD = '*** Update File: ';
const MOVE = '*** Move to: ';

function parseV4A(lines: string[]): Edit[] {
  const nonBlank: number[] = [];
  lines.forEach((l, idx) => {
    if (!isBlank(l)) nonBlank.push(idx);
  });
  if (nonBlank.length === 0) parseFail(1);
  const begin = nonBlank[0];
  if (lines[begin].trim() !== '*** Begin Patch') parseFail(begin + 1);
  const end = nonBlank[nonBlank.length - 1];
  if (end === begin || lines[end].trim() !== '*** End Patch') parseFail(lines.length + 1);

  // Split into sections: each header with the lines up to the next header.
  const sections: Array<{ at: number; kind: 'add' | 'del' | 'upd'; path: string; body: number[] }> = [];
  for (let i = begin + 1; i < end; i += 1) {
    const l = lines[i];
    if (l.startsWith(ADD)) sections.push({ at: i, kind: 'add', path: l.slice(ADD.length).trim(), body: [] });
    else if (l.startsWith(DEL)) sections.push({ at: i, kind: 'del', path: l.slice(DEL.length).trim(), body: [] });
    else if (l.startsWith(UPD)) sections.push({ at: i, kind: 'upd', path: l.slice(UPD.length).trim(), body: [] });
    else if (sections.length === 0) {
      if (!isBlank(l)) parseFail(i + 1);
    } else sections[sections.length - 1].body.push(i);
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    const body = sec.body;
    while (body.length > 0 && isBlank(lines[body[body.length - 1]])) body.pop();
    if (sec.kind === 'add') {
      const out: string[] = [];
      for (const k of body) {
        const l = lines[k];
        if (l === '') out.push('');
        else if (l[0] === '+') out.push(l.slice(1));
        else parseFail(k + 1);
      }
      edits.push(addEdit(sec.path, out));
    } else if (sec.kind === 'del') {
      if (body.length > 0) parseFail(body[0] + 1);
      edits.push(deleteEdit(sec.path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (body.length > 0 && lines[body[0]].startsWith(MOVE)) {
        moveTo = lines[body[0]].slice(MOVE.length).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; idx < body.length; idx += 1) {
        const k = body[idx];
        const l = lines[k];
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          open = { anchor: a === '' ? null : a, body: [], eof: false };
          chunks.push(open);
        } else if (l.trim() === '*** End of File') {
          if (open === null) {
            if (chunks.length > 0) parseFail(k + 1);
            open = { anchor: null, body: [], eof: false };
            chunks.push(open);
          }
          open.eof = true;
          open = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) parseFail(k + 1);
            open = { anchor: null, body: [], eof: false };
            chunks.push(open);
          }
          open.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
        } else parseFail(k + 1);
      }
      if (chunks.length === 0 && moveTo === null) parseFail(sec.at + 1);
      edits.push(updateEdit(sec.path, moveTo, chunks));
    }
  }
  return edits;
}

function addEdit(path: string, content: string[]): Edit {
  return {
    apply(st) {
      requireSafe(path);
      if (st.exists(path)) fail('exists', path);
      st.write(path, newFileText(content));
    },
  };
}

function deleteEdit(path: string): Edit {
  return {
    apply(st) {
      requireSafe(path);
      if (!st.exists(path)) fail('missing', path);
      st.remove(path);
    },
  };
}

function updateEdit(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  const edit: Edit = {
    apply(st, strict) {
      requireSafe(path);
      if (moveTo !== null) requireSafe(moveTo);
      const text = st.read(path);
      if (text === null) fail('missing', path);
      if (moveTo !== null && st.exists(moveTo)) fail('exists', moveTo);
      const doc = toDoc(text!);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const at = findAnchor(doc.lines, c.anchor, cursor, strict);
          if (at < 0) fail('no-match', path);
          cursor = at + 1;
        }
        const old = oldSide(c.body);
        const neu = newSide(c.body);
        if (old.length === 0) {
          const at = c.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
          doc.lines.splice(at, 0, ...neu);
          cursor = at + neu.length;
          continue;
        }
        const len = doc.lines.length;
        const found = locate(doc.lines, old, strict, (p) => p >= cursor && (!c.eof || p + old.length === len));
        if (found === null) fail('no-match', path);
        const pos = found!.positions[0];
        const rep = replacement(doc.lines, pos, found!.tier, c.body);
        doc.lines.splice(pos, old.length, ...rep);
        cursor = pos + rep.length;
      }
      if (moveTo !== null && moveTo !== path) {
        st.remove(path);
        st.write(moveTo, fromDoc(doc));
      } else st.write(path, fromDoc(doc));
    },
  };
  if (moveTo !== null && moveTo !== path) edit.move = [path, moveTo];
  return edit;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (section 9)

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObj = (v: Json): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An edit object turned into an Edit, or null when it is not a valid one. */
function jsonEdit(v: Json): Edit | null {
  if (!isObj(v)) return null;
  const { path, command } = v;
  if (typeof path !== 'string' || typeof command !== 'string') return null;
  if (command === 'create') {
    const ft = v.file_text;
    if (typeof ft !== 'string') return null;
    return {
      apply(st) {
        requireSafe(path);
        if (st.exists(path)) fail('exists', path);
        st.write(path, ft);
      },
    };
  }
  if (command === 'str_replace') {
    const os = v.old_str;
    const ns = v.new_str === undefined ? '' : v.new_str;
    if (typeof os !== 'string' || os === '' || typeof ns !== 'string') return null;
    return {
      apply(st) {
        requireSafe(path);
        const text = st.read(path);
        if (text === null) fail('missing', path);
        const crlf = toDoc(text!).brk === '\r\n';
        const norm = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
        const hay = norm(text!);
        const needle = norm(os);
        const first = hay.indexOf(needle);
        if (first < 0) fail('no-match', path);
        if (hay.indexOf(needle, first + 1) >= 0) fail('ambiguous', path);
        let out = hay.slice(0, first) + norm(ns) + hay.slice(first + needle.length);
        if (crlf) out = out.replace(/\n/g, '\r\n');
        st.write(path, out);
      },
    };
  }
  if (command === 'insert') {
    const line = v.insert_line;
    const ns = v.new_str;
    if (typeof line !== 'number' || !Number.isInteger(line) || typeof ns !== 'string') return null;
    return {
      apply(st) {
        requireSafe(path);
        const text = st.read(path);
        if (text === null) fail('missing', path);
        const doc = toDoc(text!);
        if (line < 0 || line > doc.lines.length) fail('no-match', path);
        doc.lines.splice(line, 0, ...patchLines(ns));
        st.write(path, fromDoc(doc));
      },
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) parseFail(1);
  if (lines[firstIdx].trimStart().startsWith('[')) {
    let value: Json;
    try {
      value = JSON.parse(text) as Json;
    } catch {
      return parseFail(firstIdx + 1);
    }
    if (!Array.isArray(value)) parseFail(firstIdx + 1);
    const edits: Edit[] = [];
    for (const item of value as Json[]) {
      const e = jsonEdit(item);
      if (e === null) parseFail(firstIdx + 1);
      edits.push(e!);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let value: Json;
    try {
      value = JSON.parse(l) as Json;
    } catch {
      return parseFail(idx + 1);
    }
    const e = jsonEdit(value);
    if (e === null) parseFail(idx + 1);
    edits.push(e!);
  });
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line (sections 1, 2 and 10)

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options | null {
  const opts: Options = { format: 'auto', check: false, strict: false, patch: null };
  const seen = new Set<string>();
  const positional: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (ended || a === '-' || !a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      ended = true;
      continue;
    }
    let name: string;
    if (a === '--check' || a === '--strict') name = a;
    else if (a.startsWith('--format=')) {
      name = '--format';
      const value = a.slice('--format='.length);
      if (!FORMATS.includes(value)) return null;
      opts.format = value;
    } else return null;
    if (seen.has(name)) return null;
    seen.add(name);
    if (name === '--check') opts.check = true;
    if (name === '--strict') opts.strict = true;
  }
  if (positional.length > 1) return null;
  opts.patch = positional.length === 1 && positional[0] !== '-' ? positional[0] : null;
  return opts;
}

function readPatch(path: string | null): string | null {
  try {
    if (path === null) return readFileSync(0, 'utf8');
    return readFileSync(path, 'utf8');
  } catch {
    return path === null ? '' : null;
  }
}

function run(argv: string[]): Exit {
  const opts = parseArgs(argv);
  if (opts === null) return { code: 2, out: ['error: usage'] };
  const text = readPatch(opts.patch);
  if (text === null) return { code: 2, out: ['error: no-patch'] };
  const lines = patchLines(text);

  let edits: Edit[];
  try {
    const format = opts.format === 'auto' ? detect(lines) : (opts.format as Format);
    if (format === null) return { code: 2, out: ['error: format'] };
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4A(lines);
    else edits = parseJson(text, lines);
    if (edits.length === 0) parseFail(1);
  } catch (err) {
    if (err instanceof Fatal) return { code: 2, out: [err.line] };
    throw err;
  }

  const tree = new Tree();
  const errors: string[] = [];
  for (const e of edits) {
    const st = tree.stage();
    try {
      e.apply(st, opts.strict);
      tree.commit(st.changes);
      if (e.move) tree.moves.push(e.move);
    } catch (err) {
      if (!(err instanceof EditFailure)) throw err;
      errors.push(`error: ${err.code} ${err.path}`);
    }
  }
  if (errors.length > 0) return { code: 1, out: [...errors, `failed: ${errors.length} of ${edits.length} edits`] };

  const rows = tree.report();
  if (!opts.check) {
    const todo = tree.pending();
    for (const [p, v] of todo) if (v === null) unlinkSync(p);
    for (const [p, v] of todo) {
      if (v === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), n === 1 ? 'ok: 1 file' : `ok: ${n} files`] };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point. In a trial (MAKEFUN_ENV_URL set) the kit's runner takes over and runs this file on every check.

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
