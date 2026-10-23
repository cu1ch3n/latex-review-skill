# README animation

A 10-second, silent, infinitely looping Remotion demo for the repository's
README. It shows only operations: type a request, open the PDF review, accept an
edit, and leave a comment. No promotional headlines, subtitles, or title cards.
The opening shows the typeset System F proof in a PDF, with the request entered
directly below the selected passage. The same proof then appears in the PDF review.
The paper is an original, illustrative System F manuscript with syntax,
inference rules, type substitution, and a preservation proof. The first edit
restores the type argument's well-formedness premise in T-TApp; the second
over-shortens a proof, prompting the comment “Keep the substitution step.”
Surrounding paragraphs, rule numbers, lemmas, and page headers remain visible.
The review UI and paper are recreated with HTML and KaTeX; this is an animation,
not a screen recording. Timing is compressed, not a claim about compilation or
agent latency.

Background references for the standard calculus:
[PLS Lab: System F](https://www.pls-lab.org/System_F) and
[UT Austin: Polymorphism and System F](https://www.cs.utexas.edu/~bornholt/courses/cs345h-22au/lectures/8-system-f/).
The demonstration prose and edits are original, not excerpts from those notes.

## Preview and export

Requires Node.js 20+ and FFmpeg on your PATH.

```sh
cd promo
npm ci
npm run dev
```

Open the local URL printed by Remotion Studio. To regenerate the checked-in GIF:

```sh
npm run check
npm run render
```

The composition uses a 1200 × 675 layout at 24 fps. Export renders every second
frame directly to lossless PNG at 1.6× scale, producing a 1920 × 1080 GIF at
12 fps with 256 colors and infinite looping. The GIF is encoded from those PNGs,
with no video compression or downscaling in between, so small text and math stay
sharp. A separate `out/promo.mp4` is also saved at 1920 × 1080, 12 fps.
The GIF is written to `../docs/demo.gif`; temporary PNGs are removed after export.
The local video and dependencies are ignored by Git. Fonts are bundled through npm; no
remote assets are requested during rendering. Remotion downloads a rendering
browser on first use. To use an existing browser, set
`REMOTION_BROWSER_EXECUTABLE` to its executable path.

`npm run stills` exports representative 1920 × 1080 frames to `out/stills/` for visual review.
The animation uses frame-derived motion, so stills, Studio and exports agree.

## Edit

- `src/Promo.tsx`: copy, scene timing, cursor paths, and component animations.
- `src/PLPaper.tsx`: the PL manuscript, inference rules, and proof variants.
- `src/style.css`: colors, type sizes, and layout.
- `src/Root.tsx`: video dimensions, frame rate, and duration.
- `scripts/render.mjs`: GIF resolution, frame rate, palette, and dithering.

The three scenes start at frames 0, 60, and 144. The last 10 frames fade back
to the opening state. Keep the demo text and buttons consistent with the actual
review app when updating the animation.

Rendering follows the [Remotion CLI](https://www.remotion.dev/docs/render).
