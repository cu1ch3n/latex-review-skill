import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { prepareFixture, RAFT } from "./prepare-fixture.ts";
import { App } from "../src/server.ts";
import { PdfDocument } from "../src/render/pdf.ts";
import { writeJson } from "../src/core/files.ts";
import type { ChangeBlock, RoundDetail } from "../src/types.ts";
const root = await prepareFixture(),
  app = new App(root),
  name = "corpus-regression";
const report: {
  source: typeof RAFT;
  rounds: unknown[];
  pages?: number;
  checks: string[];
} = { source: RAFT, rounds: [], checks: [] };
function blocks(detail: RoundDetail) {
  return [
    ...detail.sections.flatMap((s) =>
      s.blocks.filter((b): b is ChangeBlock => b.kind === "change"),
    ),
    ...detail.loose,
  ];
}
function edit(file: string, old: string, next: string) {
  const target = path.join(task.worktree, file),
    text = fs.readFileSync(target, "utf8");
  assert(text.includes(old), `Missing fixture edit in ${file}: ${old}`);
  fs.writeFileSync(target, text.replace(old, next));
}
async function publish() {
  const job = app.publisher.submit(name);
  await app.publisher.join();
  const result = app.publisher.job(job.id);
  assert.equal(result.status, "done", JSON.stringify(result.result));
  assert.equal(result.result.outcome, "published");
  const detail = app.review.roundDetail(name, result.result.round!);
  for (const unit of detail.units) {
    assert.notEqual(unit.visual, "unmapped", JSON.stringify(unit));
    assert(
      blocks(detail).some((b) => b.units.includes(unit.id)),
      `No display for ${unit.id}`,
    );
  }
  const strips = blocks(detail).flatMap((b) => [...b.before, ...b.after]);
  assert(strips.length > 0);
  for (const strip of strips) {
    assert(
      fs.existsSync(
        path.join(
          app.state,
          "rounds",
          name,
          String(detail.round).padStart(3, "0"),
          strip.src,
        ),
      ),
    );
    assert(strip.text?.length, `Missing selectable text in ${strip.src}`);
    for (const line of strip.text)
      assert.equal(line.text, line.chars.map((c) => c.text).join(""));
  }
  report.rounds.push({
    round: detail.round,
    changes: detail.units.length,
    kinds: result.result.kinds,
    selectableStrips: strips.length,
  });
  return detail;
}
const existing = app.store.one<{ closed: number | null }>(
  "SELECT closed FROM tasks WHERE name=?",
  name,
);
if (existing && !existing.closed) await app.tasks.finish(name, true);
const task = app.tasks.create(name, "Raft dissertation regression");
const head = app.repo.rev("HEAD"),
  index = fs.readFileSync(path.join(root, ".git/index"));
try {
  edit(
    "intro/intro.tex",
    "highly dynamic\nenvironments.",
    "rapidly changing\nenvironments.",
  );
  edit(
    "intro/intro.tex",
    "Thus, consensus plays a key role in building reliable\nlarge-scale software systems.",
    "",
  );
  edit(
    "intro/intro.tex",
    "Fortunately, distributed consensus can help with these challenges.",
    "Fortunately, distributed consensus can help\nwith these challenges.",
  );
  edit(
    "basicraft/consensus.tex",
    String.raw`\mathit{broadcastTime} \ll \mathit{electionTimeout}`,
    String.raw`\mathit{broadcastTime} < \mathit{electionTimeout}`,
  );
  edit(
    "intro/intro.tex",
    "The result of this work is a consensus algorithm called Raft.",
    "The result of this work is a consensus algorithm called Raft.\n% Corpus regression: source-only comment, intentionally invisible in PDF.\n",
  );
  console.log("Raft: compiling and rendering round 1 (full dissertation).");
  const first = await publish();
  assert(first.units.length >= 4);
  const lexical = first.units.find((u) =>
    u.new_text.includes("rapidly changing"),
  )!;
  assert(lexical);
  const block = blocks(first).find((b) => b.units.includes(lexical.id))!;
  assert(
    block.before.length && block.after.length,
    "Replacement must display both versions",
  );
  const before = block.before
      .flatMap((s) => s.text!.map((l) => l.text))
      .join(" "),
    after = block.after.flatMap((s) => s.text!.map((l) => l.text)).join(" ");
  assert(before.includes("highly dynamic"));
  assert(after.includes("rapidly changing"));
  assert(!after.includes("highly dynamic"));
  const equation = first.units.find(
    (u) => u.file === "basicraft/consensus.tex",
  )!;
  assert.equal(equation.visual, "text");
  assert(first.units.some((u) => u.visual === "identical"));
  app.review.decide(name, {
    action: "accept",
    changes: [lexical.id],
    round: 1,
    id: "corpus-accept",
  });
  assert(
    fs
      .readFileSync(path.join(root, "intro/intro.tex"), "utf8")
      .includes("rapidly changing"),
  );
  app.review.undo(name, "corpus-accept");
  assert(
    !fs
      .readFileSync(path.join(root, "intro/intro.tex"), "utf8")
      .includes("rapidly changing"),
  );
  app.review.decide(name, {
    action: "reject",
    changes: [equation.id],
    round: 1,
    id: "corpus-reject",
  });
  assert(
    fs
      .readFileSync(path.join(task.worktree, equation.file), "utf8")
      .includes(String.raw`\mathit{broadcastTime} \ll`),
  );
  app.review.undo(name, "corpus-reject");
  app.review.decide(name, {
    action: "comment",
    changes: [lexical.id],
    round: 1,
    id: "corpus-comment",
    body: "Use continuously changing.",
  });
  edit("intro/intro.tex", "rapidly changing", "continuously changing");
  console.log("Raft: compiling and rendering round 2 after review feedback.");
  const second = await publish();
  assert.equal(second.round, 2);
  const revised = second.units.find((u) =>
    u.new_text.includes("continuously changing"),
  )!;
  assert(
    revised.history?.some((h) => h.comment === "Use continuously changing."),
  );
  const job = app.publisher.submit(name);
  await app.publisher.join();
  assert.equal(app.publisher.job(job.id).result.outcome, "unchanged");
  const build = app.review.round(name, 2).summary.builds.at(-1)!;
  const info = JSON.parse(
    fs.readFileSync(
      path.join(app.state, "cache/builds", build, "result.json"),
      "utf8",
    ),
  );
  const pdf = new PdfDocument(info.pdf);
  report.pages = pdf.length;
  assert(pdf.length > 100);
  pdf.close();
  assert.equal(app.repo.rev("HEAD"), head);
  assert.deepEqual(fs.readFileSync(path.join(root, ".git/index")), index);
  report.checks = [
    "Full thesis compilation",
    "Text replacement, deletion, rewrapping, formula and source-only changes",
    "Both PDF sides agree with source",
    "Selectable text on every displayed strip",
    "Accept, reject and undo",
    "Comment carried to the next round",
    "Unchanged publication deduplicated",
    "Manuscript HEAD and index preserved",
  ];
  writeJson(path.join(root, "../raft-report.json"), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
