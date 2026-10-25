import { useEffect, useRef, useState, type RefObject } from "react";
import type { Decision } from "../types.ts";
import { stopState, type Stop } from "./model.ts";

type Region = { top: number; height: number };

export function ChangeMap({
  scrollRoot,
  stops,
  locations,
  decisions,
  current,
  disabled,
  onSelect,
}: {
  scrollRoot: RefObject<HTMLElement | null>;
  stops: Stop[];
  locations: string[];
  decisions: Record<string, Decision>;
  current: number;
  disabled: boolean;
  onSelect: (index: number) => void;
}) {
  const rail = useRef<HTMLElement>(null),
    drag = useRef<{ pointer: number; offset: number } | null>(null),
    [regions, setRegions] = useState<Region[]>([]),
    [viewport, setViewport] = useState<Region>({ top: 0, height: 0 });

  useEffect(() => {
    const root = scrollRoot.current,
      track = rail.current;
    if (!root || !track) return;
    let frame = 0,
      needsMeasure = true;
    const update = () => {
      frame = 0;
      const extent = Math.max(root.scrollHeight, 1),
        trackHeight = track.clientHeight,
        maxScroll = Math.max(0, extent - root.clientHeight),
        thumbHeight = Math.min(
          trackHeight,
          Math.max(8, (root.clientHeight / extent) * trackHeight),
        );
      setViewport({
        top: maxScroll
          ? (Math.max(0, Math.min(root.scrollTop, maxScroll)) / maxScroll) *
            (trackHeight - thumbHeight)
          : 0,
        height: thumbHeight,
      });
      if (!needsMeasure) return;
      needsMeasure = false;
      const origin = root.getBoundingClientRect().top + root.clientTop;
      setRegions(
        [...root.querySelectorAll<HTMLElement>("[data-stop]")].map(
          (article) => {
            const box = article.getBoundingClientRect(),
              top = Math.max(
                0,
                ((box.top - origin + root.scrollTop) / extent) * trackHeight,
              );
            return {
              top,
              height: Math.max(
                0,
                Math.min(
                  trackHeight - top,
                  Math.max(4, (box.height / extent) * trackHeight),
                ),
              ),
            };
          },
        ),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(() => {
      needsMeasure = true;
      schedule();
    });
    observer.observe(root);
    observer.observe(track);
    for (const child of root.children) observer.observe(child);
    for (const article of root.querySelectorAll("[data-stop]"))
      observer.observe(article);
    // Banners can move the document without changing its own dimensions.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const child of record.removedNodes)
          if (child instanceof Element) observer.unobserve(child);
        for (const child of record.addedNodes)
          if (child instanceof Element) observer.observe(child);
      }
      needsMeasure = true;
      schedule();
    });
    mutations.observe(root, { childList: true });
    root.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      root.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [scrollRoot, stops]);

  if (!stops.length) return null;

  function scrollAt(clientY: number, offset: number) {
    const root = scrollRoot.current,
      track = rail.current;
    if (!root || !track) return;
    const y = clientY - track.getBoundingClientRect().top - track.clientTop,
      travel = Math.max(1, track.clientHeight - viewport.height);
    root.scrollTo({
      top: ((y - offset) / travel) * (root.scrollHeight - root.clientHeight),
      behavior: "instant",
    });
  }

  return (
    <nav
      ref={rail}
      className="change-map"
      aria-label="Change map"
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target as HTMLElement).closest("button")
        )
          return;
        event.preventDefault();
        const offset = (event.target as HTMLElement).classList.contains(
          "change-map-viewport",
        )
          ? event.clientY -
            event.currentTarget.getBoundingClientRect().top -
            event.currentTarget.clientTop -
            viewport.top
          : viewport.height / 2;
        drag.current = { pointer: event.pointerId, offset };
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollAt(event.clientY, offset);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer === event.pointerId)
          scrollAt(event.clientY, drag.current.offset);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer === event.pointerId) {
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    >
      <div
        className="change-map-viewport"
        style={{ top: viewport.top, height: viewport.height }}
        aria-hidden="true"
      />
      {stops.map((stop, index) => {
        const region = regions[index];
        if (!region) return null;
        const state = stopState(stop.units, decisions),
          label = `Change ${index + 1} · ${state} · ${locations[index]}`;
        return (
          <button
            key={stop.key}
            type="button"
            className="change-map-mark"
            data-stop-index={index}
            data-state={state}
            aria-label={label}
            aria-current={index === current ? "location" : undefined}
            tabIndex={index === Math.max(0, current) ? 0 : -1}
            disabled={disabled}
            style={{ top: region.top, height: region.height }}
            onClick={() => onSelect(index)}
            onKeyDown={(event) => {
              const target =
                event.key === "ArrowDown"
                  ? index + 1
                  : event.key === "ArrowUp"
                    ? index - 1
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? stops.length - 1
                        : null;
              if (target === null) return;
              event.preventDefault();
              event.stopPropagation();
              rail.current
                ?.querySelector<HTMLButtonElement>(
                  `[data-stop-index="${Math.max(0, Math.min(stops.length - 1, target))}"]`,
                )
                ?.focus();
            }}
          >
            <span className="change-map-tooltip">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
