import { test, expect, type Page } from "@playwright/test";
import type { Feedback } from "../../src/types.ts";
test.beforeEach(async ({ page }) => {
  await page.goto("/?task=tighten-design");
  await expect(page.locator(".change").first()).toBeVisible();
});
test("renders vectors and selectable text without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".pdf-text").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".pdf-strip img")
        .evaluateAll(
          (images) =>
            images.filter(
              (img) =>
                !(img as HTMLImageElement).complete ||
                (img as HTMLImageElement).naturalWidth === 0,
            ).length,
        ),
    )
    .toBe(0);
  expect(await page.locator(".pdf-glyph").count()).toBeGreaterThan(100);
  await page.screenshot({ path: ".cache/browser-review.png", fullPage: false });
  expect(errors).toEqual([]);
});
test("ordinary copy returns selected PDF text and shortcuts do not decide it", async ({
  page,
}) => {
  const block = page
    .locator(".change")
    .filter({ has: page.locator(".pdf-text") })
    .first();
  await block.scrollIntoViewIfNeeded();
  const expected = await block
    .locator(".pdf-text-line")
    .first()
    .evaluate((line) => {
      const selection = window.getSelection()!,
        range = document.createRange();
      range.selectNodeContents(line);
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
  expect(expected.trim().length).toBeGreaterThan(2);
  await page.keyboard.press("a");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    expected,
  );
  await expect(block).toHaveAttribute("data-state", "pending");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+c" : "Control+c",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    expected,
  );
  await page.screenshot({ path: ".cache/browser-selection.png" });
});
test("mouse drag selects visible PDF glyphs at desktop and narrow widths", async ({
  page,
}) => {
  for (const width of [1440, 780]) {
    await page.setViewportSize({ width, height: 1000 });
    const line = page
      .locator(".change .pdf-text-line")
      .filter({ hasText: "rope" })
      .first();
    const glyphs = line.locator(".pdf-glyph");
    // The line wrapper has no layout box; its glyphs are absolutely positioned.
    // Center the actual text so a sticky change toolbar cannot cover it.
    await glyphs
      .first()
      .evaluate((glyph) =>
        glyph.scrollIntoView({ block: "center", behavior: "instant" }),
      );
    await expect
      .poll(() =>
        glyphs.first().evaluate((glyph) => {
          const box = glyph.getBoundingClientRect();
          return (
            document
              .elementFromPoint(box.left + 1, box.top + box.height / 2)
              ?.closest(".pdf-glyph") === glyph
          );
        }),
      )
      .toBe(true);
    const first = await glyphs.first().boundingBox(),
      last = await glyphs.last().boundingBox();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    await page.mouse.move(first!.x + 1, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      last!.x + last!.width - 1,
      last!.y + last!.height / 2,
      { steps: 20 },
    );
    await page.mouse.up();
    const selected = await page.evaluate(() =>
      window.getSelection()?.toString(),
    );
    expect(selected).toContain("rope");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  }
});
test("Copy reference preserves selection and adds file, lines and page", async ({
  page,
}) => {
  const block = page
    .locator(".change")
    .filter({ has: page.locator(".pdf-text") })
    .first();
  const selected = await block
    .locator(".pdf-text-line")
    .first()
    .evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      return s.toString();
    });
  await block
    .getByRole("button", { name: "Copy reference", exact: true })
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Round 1 · Change");
  expect(copied).toContain("paper/sections/design.tex:");
  expect(copied).toContain("p.");
  expect(copied).toContain(selected.trim());
});
test("source diff shows TeX and local accept can be undone", async ({
  page,
}) => {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const block = page.locator(".change.current");
  await block.getByRole("button", { name: "LaTeX", exact: true }).click();
  await expect(block.locator(".source-code").first()).toBeVisible();
  await block.getByRole("button", { name: /^Accept/ }).click();
  await expect(page.locator('.change[data-state="accepted"]')).toHaveCount(1);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.locator('.change[data-state="accepted"]')).toHaveCount(0);
});
test("Accept all acts once for the full round and one undo restores every change", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Accept all (7)", exact: true })
    .click();
  await expect(page.getByText("7 of 7 decided", { exact: true })).toBeVisible();
  await expect(page.locator('.change[data-state="pending"]')).toHaveCount(0);
  await expect(
    page.locator('.change-map-mark[data-state="pending"]'),
  ).toHaveCount(0);
  await expectMapAligned(page);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.getByText("0 of 7 decided", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept all (7)", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator('.change-map-mark[data-state="accepted"]'),
  ).toHaveCount(0);
  await expectMapAligned(page);
});

test("comments retain drafts and reach agent feedback with their source location", async ({
  page,
}) => {
  const comment =
    "请保留这里的技术含义。\nExplain why this bound is necessary.";
  await page
    .locator(".change.current")
    .getByRole("button", { name: "Comment", exact: true })
    .click();
  await page.getByRole("textbox", { name: /^Comment on change/ }).fill(comment);
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await expect(
    page.getByRole("textbox", { name: /^Comment on change/ }),
  ).toHaveValue(comment);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('.change[data-state="commented"]')).toHaveCount(1);
  await expect(
    page.locator('.change-map-mark[data-state="commented"]'),
  ).toHaveCount(1);
  const response = await page.request.get(
    "/api/tasks/tighten-design/feedback?after=0",
  );
  expect(response.ok()).toBe(true);
  const feedback = (await response.json()) as Feedback;
  const delivered = feedback.feedback.find(
    (item) => item.kind === "comment" && item.text === comment,
  );
  expect(delivered?.changes).toEqual([
    expect.objectContaining({
      file: "paper/sections/design.tex",
      lines: expect.any(Array),
      old: expect.any(String),
      new: expect.any(String),
    }),
  ]);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.locator('.change[data-state="commented"]')).toHaveCount(0);
});

test("review controls and overview remain usable on narrow screens", async ({
  page,
}) => {
  await expect(page.getByText("Your turn", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Message.*agent/ }),
  ).toHaveCount(0);
  for (const width of [1440, 780, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole("button", { name: "Accept all (7)", exact: true }),
    ).toBeInViewport();
    await expect(
      page
        .locator(".change.current")
        .getByRole("button", { name: "Comment", exact: true }),
    ).toBeInViewport();
    const overflow = await page
      .locator("#paper")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `.cache/browser-paper-${width}.png` });
  }
  await page.getByRole("link", { name: "All reviews" }).click();
  await expect(
    page.getByRole("heading", { name: "All reviews" }),
  ).toBeVisible();
  await page.screenshot({ path: ".cache/browser-overview-390.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: ".cache/browser-overview-1440.png" });
});

async function expectMapAligned(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("#paper")!,
          track = document.querySelector<HTMLElement>(".change-map")!,
          articles = [...root.querySelectorAll<HTMLElement>("[data-stop]")],
          marks = [...track.querySelectorAll<HTMLElement>(".change-map-mark")];
        if (marks.length !== articles.length) return Infinity;
        return Math.max(
          ...marks.map((mark, index) => {
            const documentPosition =
              (articles[index].getBoundingClientRect().top -
                root.getBoundingClientRect().top +
                root.scrollTop) /
              root.scrollHeight;
            const mapPosition =
              (mark.getBoundingClientRect().top -
                track.getBoundingClientRect().top -
                track.clientTop) /
              track.clientHeight;
            return (
              Math.abs(documentPosition - mapPosition) * track.clientHeight
            );
          }),
        );
      }),
    )
    .toBeLessThan(2);
}

test("change map navigates with pointer and keyboard and follows review layout changes", async ({
  page,
}) => {
  const map = page.getByRole("navigation", { name: "Change map" }),
    marks = map.getByRole("button"),
    changes = page.locator(".change");
  await expect(marks).toHaveCount(await changes.count());
  await expectMapAligned(page);
  const last = (await marks.count()) - 1;
  await marks.last().click();
  await expect(page.locator(".change.current")).toHaveAttribute(
    "data-stop",
    String(last),
  );
  await expect(marks.last()).toHaveAttribute("aria-current", "location");
  await expect(changes.last()).toBeInViewport();
  await marks.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(marks.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".change.current")).toHaveAttribute(
    "data-stop",
    "1",
  );

  await marks.first().click();
  await changes
    .first()
    .getByRole("button", { name: "LaTeX", exact: true })
    .click();
  await expect(changes.first().locator(".source")).toBeVisible();
  await expectMapAligned(page);
  await changes
    .first()
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(marks.first()).toHaveAttribute("data-state", "accepted");
  await expect(marks.first()).toHaveAccessibleName(
    /Change 1 · accepted · paper\/sections\/design.tex/,
  );
  await expectMapAligned(page);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(marks.first()).toHaveAttribute("data-state", "pending");
  await expectMapAligned(page);

  for (const width of [780, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(map).toBeInViewport();
    await expectMapAligned(page);
  }
  // A publishing notice moves existing content without resizing the document.
  await page.route("**/api/tasks/tighten-design/state*", async (route) => {
    const response = await route.fetch(),
      state = await response.json();
    await route.fulfill({
      response,
      json: {
        ...state,
        state: "building",
        job: { status: "running", phase: "render" },
      },
    });
  });
  await expect(
    page.getByText(/The agent is publishing a new round/),
  ).toBeVisible();
  await expectMapAligned(page);
});

test("change map viewport follows scrolling and can be dragged", async ({
  page,
}) => {
  const track = page.locator(".change-map"),
    thumb = page.locator(".change-map-viewport"),
    root = page.locator("#paper");
  await expectMapAligned(page);
  const rail = (await track.boundingBox())!,
    viewport = (await thumb.boundingBox())!;
  await page.mouse.move(rail.x + 2, viewport.y + viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(rail.x + 2, rail.y + rail.height * 0.8, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(() =>
      root.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight)),
    )
    .toBeGreaterThan(0.6);
  await expect
    .poll(() =>
      thumb.evaluate((el) => parseFloat((el as HTMLElement).style.top)),
    )
    .toBeGreaterThan(rail.height * 0.5);
  await root.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect
    .poll(() =>
      thumb.evaluate((el) => parseFloat((el as HTMLElement).style.top)),
    )
    .toBe(0);
  await expectMapAligned(page);
  await page.screenshot({ path: ".cache/browser-change-map.png" });
});
