import { test, expect } from "./bridge";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

async function capture(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const name = `${test.info().title}.png`;
  const path = process.env.OMARKD_SCREENSHOTS === "1"
    ? resolve("assets/screenshots", name) : test.info().outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await test.info().attach("Feature screenshot", { path, contentType: "image/png" });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === "passed" && !["edit-mode-autosave", "edit-mode-conflict"].includes(info.title)) await capture(page);
});

async function enter(page: Page) {
  await page.goto("/?file=/documents/reader.md");
  await expect(page.locator("#doc-path")).toHaveText("/documents/reader.md");
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown editor" })).toBeVisible();
}

test("edit-mode-autosave", async ({ page }) => {
  await enter(page);
  await expect(page.locator(".cm-lineNumbers")).toBeVisible();
  await expect(page.locator("#btn-edit")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#scroller")).toBeHidden();
  const text = page.getByRole("textbox", { name: "Markdown editor" });
  await text.fill("# Edited in Omarkd\n\n**Saved automatically**, with line numbers.\n\n- [x] Write Markdown\n- [x] Switch back to reading");
  await expect(page.locator("#status")).toHaveText("Saved");
  expect(await page.evaluate(() => window.omarkdTest.documents["/documents/reader.md"].source)).toContain("# Edited in Omarkd");
  await expect(page.locator(".cm-line").first().locator("span").last()).toHaveCSS("color", "rgb(5, 80, 174)");
  await capture(page);
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("#content h1")).toHaveText("Edited in Omarkd");
  await expect(page.locator("#content strong")).toHaveText("Saved automatically");
});

test("edit-mode-conflict", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { window.omarkdTest.documents["/documents/reader.md"].source = "# External change"; });
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# My unsaved edits\n\nNever overwrite external changes silently.");
  await expect(page.locator("#editor-message")).toContainText("autosave is paused");
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown editor" })).toBeVisible();
  expect(await page.evaluate(() => window.omarkdTest.documents["/documents/reader.md"].source)).toBe("# External change");
  await capture(page);
  await page.getByRole("button", { name: "Overwrite disk with my edits" }).click();
  await expect(page.locator("#status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("#content h1")).toHaveText("My unsaved edits");
});

test("editor-save-failure-and-retry", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { window.omarkdTest.saveError = "Permission denied"; });
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# Kept locally");
  await expect(page.locator("#editor-message")).toContainText("Permission denied");
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("#editor-panel")).toBeVisible();
  await page.evaluate(() => { window.omarkdTest.saveError = null; });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.locator("#status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("#content h1")).toHaveText("Kept locally");
});

test("editor-view-waits-for-pending-save", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { window.omarkdTest.saveDelay = 500; });
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# Saved before viewing");
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("#btn-edit")).toBeDisabled();
  await expect(page.locator("#editor-panel")).toBeVisible();
  await expect(page.locator("#content h1")).toHaveText("Saved before viewing");
  await expect(page.locator("#editor-panel")).toBeHidden();
});

test("editor-external-reload-and-discard", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    window.omarkdTest.documents["/documents/reader.md"].source = "# Clean external change";
    window.omarkdTest.emit("omarkd://file-changed", null);
  });
  await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveText("# Clean external change");
  await page.evaluate(() => { window.omarkdTest.documents["/documents/reader.md"].source = "# Second external change"; });
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# Mine");
  await expect(page.locator("#editor-message")).toContainText("autosave is paused");
  await page.getByRole("button", { name: "Discard edits and reload disk" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveText("# Second external change");
  await expect(page.locator("#status")).toHaveText("Saved");
});

test("editor-theme-and-find", async ({ page }) => {
  await enter(page);
  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(page.locator("#editor-host .cm-editor")).toHaveCSS("background-color", "rgb(13, 17, 23)");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.locator(".cm-search")).toBeVisible();
  await page.locator(".cm-search input[name=search]").fill("Markdown");
  await expect(page.getByRole("textbox", { name: "Markdown editor" })).toBeVisible();
  await expect(page.locator("#findbar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Toggle outline" })).toBeDisabled();
});

test("editor-undo-and-serialized-saves", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { window.omarkdTest.saveDelay = 600; });
  const text = page.getByRole("textbox", { name: "Markdown editor" });
  await text.fill("# First save");
  await expect(page.locator("#status")).toHaveText("Saving...");
  await text.fill("# Latest save");
  await expect(page.locator("#status")).toHaveText("Saved");
  const writes = await page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "save_source"));
  expect(writes.map(call => call.args.source)).toEqual(["# First save", "# Latest save"]);
  expect(writes[1].args.expected).toBe("# First save");
  await text.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(text).toHaveText("# First save");
  await text.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
  await expect(text).toHaveText("# Latest save");
});

test("editor-navigation-save-guard", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    window.omarkdTest.saveError = "Read-only file";
    window.omarkdTest.dialogResult = ["/documents/second.md", "/documents/code.md"];
  });
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# Unsaved navigation draft");
  await expect(page.locator("#editor-message")).toContainText("Read-only file");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(page.locator("#doc-path")).toHaveText("/documents/reader.md");
  expect(await page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "open_in_new_window"))).toHaveLength(0);
  await page.evaluate(() => { window.omarkdTest.saveError = null; });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.locator("#status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(page.locator("#doc-path")).toHaveText("/documents/second.md");
  expect(await page.evaluate(() => window.omarkdTest.documents["/documents/reader.md"].source)).toBe("# Unsaved navigation draft");
});

test("editor-quit-save-guard", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { window.omarkdTest.saveError = "Cannot write"; });
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# Keep my quit draft");
  await expect(page.locator("#editor-message")).toContainText("Cannot write");
  await page.evaluate(() => window.omarkdTest.emit("omarkd://before-quit", 1));
  await expect.poll(() => page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "finish_quit").at(-1)?.args)).toEqual({ request: 1, saved: false });
  await expect(page.locator("#editor-panel")).toBeVisible();
  await page.evaluate(() => { window.omarkdTest.saveError = null; });
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.locator("#status")).toHaveText("Saved");
  await page.evaluate(() => window.omarkdTest.emit("omarkd://before-quit", 2));
  await expect.poll(() => page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "finish_quit").at(-1)?.args)).toEqual({ request: 2, saved: true });
  await expect(page.locator("#editor-panel")).toBeHidden();
});

test("editor-compact-window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 740 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Edit mode" })).toBeDisabled();
  await enter(page);
  await page.getByRole("textbox", { name: "Markdown editor" }).fill("# Compact editor\n\nA long Markdown paragraph wraps within a small window while the line numbers stay visible and the toolbar remains accessible.");
  await expect(page.locator("#status")).toHaveText("Saved");
  const theme = await page.locator("#btn-theme").boundingBox();
  expect(theme!.x + theme!.width).toBeLessThanOrEqual(420);
  expect(await page.locator(".cm-scroller").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
