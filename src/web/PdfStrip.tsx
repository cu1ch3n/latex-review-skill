import { memo, useMemo, type CSSProperties } from "react";
import type { Strip, TextGlyph } from "../types.ts";
let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
function width(text: string) {
  if (widths.has(text)) return widths.get(text)!;
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return 1;
  context.font = '100px "Times New Roman", serif';
  const measured = context.measureText(text).width / 100;
  widths.set(text, measured);
  return measured || 1;
}
function style(glyph: TextGlyph, image: Strip): CSSProperties {
  const [x0, y0, x1, y1] = glyph.rect,
    height = Math.max(y1 - y0, 0.1),
    scaleX = (x1 - x0) / (height * width(glyph.text));
  return {
    left: `${(100 * x0) / image.width}%`,
    top: `${(100 * y0) / image.height}%`,
    fontSize: `${(100 * height) / image.width}cqw`,
    transform: `scaleX(${scaleX})`,
  };
}
export const PdfStrip = memo(function PdfStrip({
  image,
  base,
  label,
  clean = false,
}: {
  image: Strip;
  base: string;
  label: string;
  clean?: boolean;
}) {
  const text = useMemo(
    () =>
      image.text?.map((line, i) => (
        <span className="pdf-text-line" key={i}>
          {line.chars.map((glyph, j) => (
            <span key={j} className="pdf-glyph" style={style(glyph, image)}>
              {glyph.text}
            </span>
          ))}
          {"\n"}
        </span>
      )),
    [image],
  );
  return (
    <div
      className="pdf-strip"
      data-page={image.label}
      style={{ aspectRatio: `${image.width}/${image.height}` }}
    >
      <img
        src={base + (clean ? image.clean : image.src)}
        alt={image.text?.length ? "" : label}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
        draggable={false}
        aria-hidden={Boolean(image.text?.length)}
      />
      {image.text?.length ? (
        <div
          className="pdf-text"
          role="region"
          aria-label={`${label}, PDF page ${image.label}`}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
});
