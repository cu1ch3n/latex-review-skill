import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { Fixture } from "./helpers.ts";
import { run, which } from "../../src/core/process.ts";
import { containsCenter } from "../../src/render/pdf.ts";
import { ROOT } from "../../src/runtime.ts";
import type { ChangeBlock, Strip, Rect } from "../../src/types.ts";
const tex = Boolean(which("latexmk") && which("pdflatex"));
const paragraph =
  "A replicated state machine records commands in a durable log. Each replica applies committed commands in order. The invariant remains valid while leadership changes. ";
interface Case {
  name: string;
  body: string;
  from: string;
  to: string;
  options?: string;
  packages?: string;
  before?: string;
  after?: string;
  removed?: string;
  added?: string;
  visual?: string;
  minimumPages?: number;
  relocated?: boolean;
}
const cases: Case[] = [
  {
    name: "two columns with a repeated sentence",
    options: "twocolumn",
    body: String.raw`\section{Columns}
Left column sentinel. The protocol uses an old invariant.
${paragraph.repeat(14)}
\newpage
Right column sentinel. The protocol uses an old invariant.
${paragraph.repeat(4)}`,
    from: "Right column sentinel. The protocol uses an old invariant.",
    to: "Right column sentinel. The protocol uses a stronger invariant.",
    before: "old invariant",
    after: "stronger invariant",
    removed: "old",
    added: "stronger",
  },
  {
    name: "footnote wraps at the bottom of a page",
    body: String.raw`\section{Footnotes}
${paragraph.repeat(6)}
The theorem has a caveat\footnote{The old caveat assumes reliable delivery. ${paragraph.repeat(2)}}.
${paragraph.repeat(2)}`,
    from: "The old caveat assumes",
    to: "The revised caveat assumes",
    before: "old caveat",
    after: "revised caveat",
    removed: "old",
    added: "revised",
  },
  {
    name: "ligatures and forced hyphenation",
    body: String.raw`\section{Words}
\begin{minipage}{130pt}
An efficient implementation supports affinity and offers effective synchronization.
\end{minipage}`,
    from: "efficient implementation",
    to: "flexible implementation",
    before: "efficient",
    after: "flexible",
    removed: "efficient",
    added: "flexible",
  },
  {
    name: "aligned formulas with a changed exponent",
    packages: "amsmath",
    body: String.raw`\section{Formula}
The bound follows from
\begin{align}
 f(x)&=x^2 + y^2,\\
 g(x)&=\frac{x+1}{y+1}.
\end{align}
The second formula remains unchanged.`,
    from: "x^2 + y^2",
    to: "x^3 + y^2",
    before: "2",
    after: "3",
    removed: "2",
    added: "3",
  },
  {
    name: "pure deletion at the end of a section",
    body: String.raw`\section{Deletion}
The protocol preserves the invariant.

This obsolete sentence should disappear.

\section{Next}
This unrelated sentinel must remain.`,
    from: "This obsolete sentence should disappear.\n",
    to: "",
    before: "obsolete sentence",
    removed: "obsolete",
  },
  {
    name: "duplicate paragraphs claim only their own source",
    body: String.raw`\section{Ownership}
First sentinel: The old invariant implies safety.
${paragraph}

${paragraph}

${paragraph}

Second sentinel: The old invariant implies safety.
${paragraph}`,
    from: "Second sentinel: The old invariant",
    to: "Second sentinel: The revised invariant",
    before: "Second sentinel",
    after: "Second sentinel",
    removed: "old",
    added: "revised",
  },
  {
    name: "a large float changes position after reflow",
    body: String.raw`\section{Floating}
${paragraph.repeat(35)}
\begin{figure}[tbp]
\centering\fbox{\rule{0pt}{220pt}\rule{250pt}{0pt}}
\caption{An unchanged floating diagram.}\label{fig:box}
\end{figure}
The old protocol accepts a command only after a majority confirms its entry.
${paragraph.repeat(6)}`,
    from: "The old protocol accepts a command only after a majority confirms its entry.",
    to: "The revised protocol accepts a command after a majority confirms it, keeping the safety invariant explicit even when a leader fails.",
    before: "old protocol",
    after: "revised protocol",
    removed: "old",
    added: "revised",
    minimumPages: 2,
  },
  {
    name: "explicit cross-page replacement",
    body: String.raw`\section{Page move}
${paragraph.repeat(3)}
The old protocol is safe.
`,
    from: "The old protocol is safe.",
    to: "\\newpage\nThe revised protocol is safe.",
    before: "old protocol",
    after: "revised protocol",
    removed: "old",
    added: "revised",
    relocated: true,
  },
  {
    name: "caption-only edit beside an unchanged drawing",
    body: String.raw`\section{Caption}
See Figure~\ref{fig:caption}.
\begin{figure}[h]
\centering\fbox{A diagram with unchanged labels}
\caption{The old protocol.}\label{fig:caption}
\end{figure}`,
    from: "\\caption{The old protocol.}",
    to: "\\caption{The revised protocol.}",
    before: "old protocol",
    after: "revised protocol",
    removed: "old",
    added: "revised",
  },
  {
    name: "color-only figure change",
    packages: "xcolor",
    body: String.raw`\section{Color}
\begin{figure}[h]
\centering{\color{red}\rule{100pt}{40pt}}
\caption{The same caption.}
\end{figure}`,
    from: "\\color{red}",
    to: "\\color{blue}",
    visual: "layout",
  },
  {
    name: "verbatim whitespace changes layout",
    body: String.raw`\section{Code}
\begin{verbatim}
if ready:
  commit()
\end{verbatim}`,
    from: "  commit()",
    to: "      commit()",
    visual: "layout",
  },
  {
    name: "paragraph boundary is not a no-op",
    body: String.raw`\section{Paragraphs}
The first paragraph states the invariant.

The second paragraph proves the invariant.`,
    from: "invariant.\n\nThe second",
    to: "invariant. The second",
    visual: "layout",
  },
  {
    name: "a table row on a later page",
    packages: "longtable",
    body: String.raw`\section{Long table}
\begin{longtable}{ll}
Index & State \\
\hline
${Array.from({ length: 85 }, (_, i) => `${i} & ${i === 70 ? "oldstate" : "unchanged"} \\\\`).join("\n")}
\end{longtable}`,
    from: "70 & oldstate",
    to: "70 & newstate",
    before: "oldstate",
    after: "newstate",
    removed: "oldstate",
    added: "newstate",
    minimumPages: 2,
  },
];
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
function marked(strip: Strip, folder: string) {
  const svg = fs.readFileSync(path.join(folder, strip.src), "utf8"),
    rects = [
      ...svg.matchAll(
        /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="[^"]+" fill-opacity=".18"\/>/g,
      ),
    ].map((m) => [+m[1], +m[2], +m[1] + +m[3], +m[2] + +m[4]] as Rect);
  return (strip.text ?? [])
    .map((line) =>
      line.chars
        .map((c) =>
          rects.some((r) => containsCenter(r, c.rect)) ? c.text : " ",
        )
        .join(""),
    )
    .join("\n");
}
for (const scenario of cases)
  it.skipIf(!tex)(
    scenario.name,
    async () => {
      const f = new Fixture();
      const source = String.raw`\documentclass[${scenario.options ?? ""}]{article}
\usepackage[margin=50pt]{geometry}
${scenario.packages ? `\\usepackage{${scenario.packages}}` : ""}
\usepackage{hyperref}
\begin{document}
${scenario.body}
\end{document}
`;
      f.write("paper/main.tex", source);
      f.repo.run(["add", "."]);
      f.repo.run(["commit", "-qm", "Adversarial fixture"]);
      const app = f.app();
      try {
        const task = app.tasks.create("tricky");
        f.edit(task, "paper/main.tex", scenario.from, scenario.to);
        const job = app.publisher.submit(task.name);
        await app.publisher.join();
        const result = app.publisher.job(job.id);
        expect(result.status, JSON.stringify(result.result)).toBe("done");
        const detail = app.review.roundDetail(task.name, 1);
        expect(detail.units).toHaveLength(1);
        expect(detail.units[0].visual).not.toBe("unmapped");
        if (scenario.visual)
          expect(detail.units[0].visual).toBe(scenario.visual);
        const blocks = [
            ...detail.sections.flatMap((s) =>
              s.blocks.filter((b): b is ChangeBlock => b.kind === "change"),
            ),
            ...detail.loose,
          ],
          before = blocks.flatMap((b) => b.before),
          after = blocks.flatMap((b) => b.after),
          text = (strips: Strip[]) =>
            normalized(
              strips
                .flatMap((s) => s.text?.map((l) => l.text) ?? [])
                .join("\n"),
            ),
          folder = path.join(app.state, "rounds/tricky/001");
        if (scenario.before) expect(text(before)).toContain(scenario.before);
        if (scenario.after) expect(text(after)).toContain(scenario.after);
        if (scenario.removed)
          expect(
            normalized(before.map((s) => marked(s, folder)).join("\n")),
          ).toContain(scenario.removed);
        if (scenario.added)
          expect(
            normalized(after.map((s) => marked(s, folder)).join("\n")),
          ).toContain(scenario.added);
        if (scenario.name.startsWith("two columns")) {
          expect(
            normalized(before.map((s) => marked(s, folder)).join("\n")),
          ).toBe("an old");
          expect(
            normalized(after.map((s) => marked(s, folder)).join("\n")),
          ).toBe("a stronger");
        }
        if (scenario.relocated)
          expect(before.some((a) => after.some((b) => a.page !== b.page))).toBe(
            true,
          );
        if (scenario.removed)
          expect(
            normalized(before.map((s) => marked(s, folder)).join("\n")).split(
              scenario.removed,
            ).length - 1,
          ).toBe(1);
        if (scenario.added)
          expect(
            normalized(after.map((s) => marked(s, folder)).join("\n")).split(
              scenario.added,
            ).length - 1,
          ).toBe(1);
        if (scenario.name.includes("duplicate")) {
          expect(text(before)).not.toContain("First sentinel");
          expect(text(after)).not.toContain("First sentinel");
        }
        if (scenario.name.includes("deletion"))
          expect(text(after)).not.toContain("obsolete");
        // Independently extract both complete PDFs with Poppler, so an extraction mistake
        // in our MuPDF text layer cannot make a wrong expected phrase pass unnoticed.
        if (which("pdftotext")) {
          const builds = app.review.round(task.name, 1).summary.builds;
          for (const [key, expected] of [
            [builds[0], scenario.before],
            [builds.at(-1)!, scenario.after],
          ] as const) {
            const info = JSON.parse(
                fs.readFileSync(
                  path.join(app.state, "cache/builds", key, "result.json"),
                  "utf8",
                ),
              ),
              plain = run("pdftotext", [
                "-layout",
                info.pdf,
                "-",
              ]).stdout.toString();
            if (expected) expect(normalized(plain)).toContain(expected);
            if (scenario.minimumPages)
              expect(plain.split("\f").length - 1).toBeGreaterThanOrEqual(
                scenario.minimumPages,
              );
          }
        }
      } catch (error) {
        fs.cpSync(
          f.base,
          path.join(
            ROOT,
            ".cache/tricky-failures",
            scenario.name.replaceAll(" ", "-") + "-" + Date.now(),
          ),
          { recursive: true },
        );
        throw error;
      } finally {
        await f.close();
      }
    },
    120000,
  );
