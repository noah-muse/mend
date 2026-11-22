// Extra checks for mend beyond the public practice set: tolerant matching (trailing whitespace, indentation drift),
// choosing among several candidate locations, and each edit format end to end.
// Run from the repository root: node tests/extra.ts

import { runCheck } from '../runner.ts';

interface Case {
  name: string;
  argv: string[];
  stdin?: string;
  files: Record<string, string>;
  exit: number;
  stdout: string;
  /** Files the run changes: new text, or null for a file it deletes. Every other file must be unchanged. */
  after?: Record<string, string | null>;
}

const py = 'def a():\n    x = 1\n    return x\n\ndef b():\n    x = 1\n    return x\n';

const cases: Case[] = [
  {
    name: 'unified: trailing whitespace drift matches at tier 1',
    argv: ['p.diff'],
    files: { 'f.txt': 'one  \ntwo\t\nthree\n', 'p.diff': '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n' },
    exit: 0,
    stdout: 'M f.txt\nok: 1 file\n',
    after: { 'f.txt': 'one  \nTWO\nthree\n' },
  },
  {
    name: 'unified: indentation drift matches at tier 2 and re-indents new lines',
    argv: ['p.diff'],
    files: {
      'm.py': 'class K:\n        def f(self):\n            return 1\n',
      'p.diff': '--- m.py\n+++ m.py\n@@ -2,2 +2,3 @@\n def f(self):\n-    return 1\n+    y = 2\n+    return y\n',
    },
    exit: 0,
    stdout: 'M m.py\nok: 1 file\n',
    after: { 'm.py': 'class K:\n        def f(self):\n            y = 2\n            return y\n' },
  },
  {
    name: 'unified: --strict refuses whitespace drift',
    argv: ['--strict', 'p.diff'],
    files: { 'f.txt': 'one  \ntwo\n', 'p.diff': '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n' },
    exit: 1,
    stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n',
  },
  {
    name: 'unified: of two candidates the one nearest the hunk line number wins',
    argv: ['p.diff'],
    files: { 'm.py': py, 'p.diff': '--- m.py\n+++ m.py\n@@ -6,2 +6,2 @@\n-    x = 1\n+    x = 2\n     return x\n' },
    exit: 0,
    stdout: 'M m.py\nok: 1 file\n',
    after: { 'm.py': py.replace('def b():\n    x = 1', 'def b():\n    x = 2') },
  },
  {
    name: 'unified: wrong line numbers still find the single occurrence',
    argv: ['p.diff'],
    files: { 'f.txt': 'a\nb\nc\nd\ne\n', 'p.diff': '--- f.txt\n+++ f.txt\n@@ -40,2 +40,2 @@\n d\n-e\n+E\n' },
    exit: 0,
    stdout: 'M f.txt\nok: 1 file\n',
    after: { 'f.txt': 'a\nb\nc\nd\nE\n' },
  },
  {
    name: 'unified: rename with hunk reports R, create and delete in one patch',
    argv: ['p.diff'],
    files: {
      'old.txt': 'x\ny\n',
      'gone.txt': 'bye\n',
      'p.diff':
        'diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n' +
        'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n' +
        '--- /dev/null\n+++ b/dir/made.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n',
    },
    exit: 0,
    stdout: 'A dir/made.txt\nD gone.txt\nR old.txt -> new.txt\nok: 3 files\n',
    after: { 'new.txt': 'x\nz\n', 'dir/made.txt': 'hello\nworld', 'old.txt': null, 'gone.txt': null },
  },
  {
    name: 'search-replace: tier 0 unique wins over tier-2 duplicates; CRLF kept',
    argv: ['p.txt'],
    files: { 'f.txt': '  v = 1\r\nv = 1\r\nend\r\n', 'p.txt': 'f.txt\n```\n<<<<<<< SEARCH\nv = 1\n=======\nv = 9\n>>>>>>> REPLACE\n```\n' },
    exit: 0,
    stdout: 'M f.txt\nok: 1 file\n',
    after: { 'f.txt': '  v = 1\r\nv = 9\r\nend\r\n' },
  },
  {
    name: 'search-replace: indentation drift re-indents the replacement',
    argv: ['p.txt'],
    files: {
      'f.js': 'function f() {\n\t\tif (a) {\n\t\t\treturn 1;\n\t\t}\n}\n',
      'p.txt': 'f.js\n<<<<<<< SEARCH\nif (a) {\n  return 1;\n}\n=======\nif (a) {\n  log();\n  return 2;\n}\n>>>>>>> REPLACE\n',
    },
    exit: 0,
    stdout: 'M f.js\nok: 1 file\n',
    after: { 'f.js': 'function f() {\n\t\tif (a) {\n\t\t  log();\n\t\t  return 2;\n\t\t}\n}\n' },
  },
  {
    name: 'search-replace: same text twice is ambiguous and nothing is written',
    argv: ['p.txt'],
    files: { 'm.py': py, 'n.txt': 'k\n', 'p.txt': 'n.txt\n<<<<<<< SEARCH\nk\n=======\nK\n>>>>>>> REPLACE\nm.py\n<<<<<<< SEARCH\n    return x\n=======\n    return -x\n>>>>>>> REPLACE\n' },
    exit: 1,
    stdout: 'error: ambiguous m.py\nfailed: 1 of 2 edits\n',
  },
  {
    name: 'v4a: anchor and cursor pick the second of two identical blocks, with indentation drift',
    argv: ['p.txt'],
    files: { 'm.py': py, 'p.txt': '*** Begin Patch\n*** Update File: m.py\n@@ def b():\n-x = 1\n+x = 5\n*** End Patch\n' },
    exit: 0,
    stdout: 'M m.py\nok: 1 file\n',
    after: { 'm.py': py.replace('def b():\n    x = 1', 'def b():\n    x = 5') },
  },
  {
    name: 'v4a: move with a change, add and delete',
    argv: ['-'],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: sub/b.txt\n one\n-two\n+2\n\n*** Add File: c.txt\n+c1\n\n+c3\n*** Delete File: d.txt\n*** End Patch\n',
    files: { 'a.txt': 'one\ntwo\n', 'd.txt': 'd\n' },
    exit: 0,
    stdout: 'A c.txt\nD d.txt\nR a.txt -> sub/b.txt\nok: 3 files\n',
    after: { 'sub/b.txt': 'one\n2\n', 'c.txt': 'c1\n\nc3\n', 'a.txt': null, 'd.txt': null },
  },
  {
    name: 'v4a: end-of-file chunk takes only the occurrence at the end',
    argv: ['p.txt'],
    files: { 'f.txt': 'end\nmid\nend\n', 'p.txt': '*** Begin Patch\n*** Update File: f.txt\n-end\n+END\n*** End of File\n*** End Patch\n' },
    exit: 0,
    stdout: 'M f.txt\nok: 1 file\n',
    after: { 'f.txt': 'end\nmid\nEND\n' },
  },
  {
    name: 'json: str_replace in a CRLF file, then insert, as JSON Lines',
    argv: ['e.jsonl'],
    files: {
      'w.txt': 'alpha\r\nbeta\r\n',
      'e.jsonl': '{"command":"str_replace","path":"w.txt","old_str":"alpha\\nbeta","new_str":"A\\nB"}\n\n{"command":"insert","path":"w.txt","insert_line":1,"new_str":"mid\\n"}\n',
    },
    exit: 0,
    stdout: 'M w.txt\nok: 1 file\n',
    after: { 'w.txt': 'A\r\nmid\r\nB\r\n' },
  },
  {
    name: 'json: array with an unsafe path and a missing file reports both',
    argv: ['e.json'],
    files: { 'e.json': '[\n {"command":"create","path":"../x","file_text":"x"},\n {"command":"str_replace","path":"nope.txt","old_str":"a"}\n]\n' },
    exit: 1,
    stdout: 'error: unsafe ../x\nerror: missing nope.txt\nfailed: 2 of 2 edits\n',
  },
  {
    name: 'cli: --check prints the changes and writes nothing',
    argv: ['--check', 'e.json'],
    files: { 'e.json': '[{"command":"create","path":"n.txt","file_text":"hi"}]' },
    exit: 0,
    stdout: 'A n.txt\nok: 1 file\n',
  },
  {
    name: 'cli: -- makes an option-like name the patch path',
    argv: ['--', '--strict'],
    files: { '--strict': '[{"command":"create","path":"n.txt","file_text":"hi"}]' },
    exit: 0,
    stdout: 'A n.txt\nok: 1 file\n',
    after: { 'n.txt': 'hi' },
  },
  {
    name: 'cli: option given twice is a usage error',
    argv: ['--check', '--check', 'p'],
    files: {},
    exit: 2,
    stdout: 'error: usage\n',
  },
];

let passed = 0;
for (const c of cases) {
  const got = runCheck({ id: c.name, argv: c.argv, stdin: c.stdin ?? null, files: c.files });
  const want: Record<string, string> = { ...c.files };
  for (const [k, v] of Object.entries(c.after ?? {})) {
    if (v === null) delete want[k];
    else want[k] = v;
  }
  const why: string[] = [];
  if (got.exit !== c.exit) why.push(`exit ${got.exit}, expected ${c.exit}`);
  if (got.stdout !== c.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(c.stdout)}`);
  if (JSON.stringify(Object.entries(got.files).sort()) !== JSON.stringify(Object.entries(want).sort())) {
    why.push(`files ${JSON.stringify(got.files)}, expected ${JSON.stringify(want)}`);
  }
  if (why.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${cases.length} extra checks passed\n`);
process.exitCode = passed === cases.length ? 0 : 1;
