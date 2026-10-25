# Raft regression corpus

We use Diego Ongaro’s *Consensus: Bridging Theory and Practice* (Stanford dissertation, 2014), from [ongardie/dissertation](https://github.com/ongardie/dissertation), revision `0c10ea1b53d73bf6d163bdde8e4141a1cbd8f36a`. The upstream [LICENSE](https://github.com/ongardie/dissertation/blob/0c10ea1b53d73bf6d163bdde8e4141a1cbd8f36a/LICENSE) offers CC-BY-3.0-US or CC-BY-4.0; this fixture uses CC-BY-4.0. Copyright Diego Ongaro, 2014.

The complete source is downloaded into `.cache/fixtures/raft` and prepared in `.cache/corpus/raft`. These directories are ignored by Git. The script converts SVG figures to PDF with librsvg, including the named layers in upstream Makefrag files, and adds local review configuration. The thesis text is unchanged in the baseline. Regression edits are artificial test mutations in a separate worktree; they are not scholarly corrections or an endorsement by the author.

Requirements: Node.js 22.22+, Git, a full TeX installation with `latexmk`, `pdflatex`, `bibtex`, `synctex`, and `rsvg-convert` (`brew install librsvg`, or `apt install librsvg2-bin`).

```sh
npm run fixture:prepare  # download and prepare the pinned source
npm run test:corpus      # compile full PDFs and exercise two review rounds
```

The second command checks text replacement, sentence deletion, source rewrapping, an equation change and an invisible comment. It verifies both PDF sides, every unit’s display coverage, every strip’s selectable text, accept/reject/undo, comment history in round two, deduplication, and preservation of the manuscript HEAD/index. The resulting report is `.cache/corpus/raft-report.json`. The review and compiled PDFs remain in the disposable fixture so failures can be inspected. Running again replaces only its dedicated `corpus-regression` task.

The TeX adversarial suite adds double columns, footnotes, ligatures, aligned formulas, pure deletion, duplicate paragraphs, floated diagrams, explicit page relocation, caption edits, figure colors, verbatim indentation, paragraph boundaries and multi-page tables. It checks the actual SVG highlights against the intended changed words and cross-checks full PDF text with Poppler when available. Failures are preserved under `.cache/tricky-failures/`.

The browser-free CLI integration suite delivers 252 opinions, a long Chinese comment, multi-round revisions, undo corrections, notifications during a wait and compiler failures. It verifies replay and delivery cursors through the actual CLI and HTTP API.

Small deterministic rendering regressions additionally cover changed suffixes, crop-edge glyphs, hyphenation, page relocation past a float, moved unchanged lines, and vector/clean strip generation. Playwright tests native mouse selection at desktop and narrow widths, clipboard copying, contextual references and undo using the bundled demo paper.

CI runs this corpus on each pull request and push, and weekly to catch dependency or environment changes. Failure logs and browser traces are retained as artifacts.
