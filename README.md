# mend

One patch tool for every AI edit format: unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches and JSON text-editor tool calls, applied all-or-nothing to the tree in the working directory.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library only. Edits are located at the first of three matching tiers (exact, trailing
whitespace ignored, surrounding whitespace ignored, with re-indentation of new lines at the last tier); `--strict`
keeps to exact matching.

- `main.ts`: the tool.
- `runner.ts`: the competition kit's trial runner (MIT), kept as shipped; `main.ts` hands over to it when
  `MAKEFUN_ENV_URL` is set.
- `tests/extra.ts`: extra checks for tolerant matching and every format: `node tests/extra.ts`.
