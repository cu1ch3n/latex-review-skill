import { test, expect } from "@playwright/test";
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
    await line.scrollIntoViewIfNeeded();
    const glyphs = line.locator(".pdf-glyph"),
      first = await glyphs.first().boundingBox(),
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
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.getByText("0 of 7 decided", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept all (7)", exact: true }),
  ).toBeEnabled();
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
