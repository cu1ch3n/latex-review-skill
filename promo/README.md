# README animation

An 18.8-second, silent Remotion animation for the repository's README. The GIF
loops continuously; the MP4 preserves smoother cursor and scrolling motion.
Both exports use the review interface's white surfaces, TeX Gyre Pagella
headings, sans-serif controls, colored diffs, rounded toolbars, and change map.

## Walkthrough

1. Ask the agent to review the type-safety proof in an illustrative manuscript.
2. Inspect a missing well-formedness premise in T-TApp and accept the correction.
3. Follow the document and minimap to a shortened proof; comment “Keep the substitution step.”
4. Accept the five remaining proposals as a batch, completing the round.
5. Inspect the revised proof with its comment history, then accept the final revision.

The scene shows the round completing before the agent returns a revision, in
line with the CLI feedback workflow. Typography, surrounding paragraphs,
equation numbers, and source locations remain visible throughout. Motion uses
short dissolves, a continuous document scroll, and measured cursor paths anchored
to the rendered controls. There are no promotional headings, subtitles, or title cards.

This is an HTML/KaTeX reconstruction of the interface, not a screen recording.
Timing is compressed and does not represent compilation or agent latency. The
System F manuscript and its edits are original examples, not changes to a user's
paper. Background references are [PLS Lab: System F](https://www.pls-lab.org/System_F)
and [UT Austin: Polymorphism and System F](https://www.cs.utexas.edu/~bornholt/courses/cs345h-22au/lectures/8-system-f/).

## Preview and export

Requires Node.js 22.22+ and FFmpeg on `PATH`.

```sh
cd promo
npm ci
npm run dev
```

Open the local URL printed by Remotion Studio. To export:

```sh
npm run check
npm run stills
npm run render
```

| Artifact          | Output                                                 |
| ----------------- | ------------------------------------------------------ |
| README GIF        | `../docs/demo.gif`, 1920 × 1080, 15 fps, infinite loop |
| Video             | `../docs/demo.mp4`, 1920 × 1080, 30 fps, H.264         |
| Inspection frames | `out/stills/`, 1920 × 1080 PNGs                        |

The composition is 1200 × 675 at 30 fps, with 564 frames. Rendering uses a 1.6×
scale and lossless PNG intermediates. The GIF is encoded directly from those
frames with a 256-color palette; the video is encoded separately. Temporary
frames are removed after a successful export.

To inspect selected frames:

```sh
node scripts/stills.mjs 138 310 468
```

Fonts are local: the serif family comes from `../src/web/fonts/`, Inter from
its npm package, and mathematical glyphs from KaTeX. The font notices remain
with their respective distributions. Remotion downloads a rendering browser on
first use; set `REMOTION_BROWSER_EXECUTABLE` to use an existing browser instead.

## Editing

- `src/Promo.tsx`: scene timing, workflow, cursor anchors, and minimap motion.
- `src/PLPaper.tsx`: manuscript, inference rules, and proof variants.
- `src/style.css`: typography, colors, and composition layout.
- `src/Root.tsx`: composition dimensions and frame rate.
- `scripts/render.mjs`: GIF and video encoding.

Animation is derived entirely from the frame number, including cursor clicks
and text entry. Keep labels, counts, review decisions, and revision timing
consistent with the actual app. Inspect key frames and the completed loop after
changing layout or timing.
