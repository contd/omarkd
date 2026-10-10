import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./bridge";

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function openDocument(page: Page, name = "reader") {
  await page.goto(`/?file=/documents/${name}.md`);
  await expect(page.locator("#doc-path")).toHaveText(`/documents/${name}.md`);
  await expect(page.locator("#content h1")).toBeVisible();
}

async function commandCount(page: Page, command: string) {
  return page.evaluate(command => window.omarkdTest.calls.filter(call => call.command === command).length, command);
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed") return;
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const filename = `${info.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  const path = process.env.OMARKD_SCREENSHOTS === "1"
    ? resolve("assets/screenshots", filename)
    : info.outputPath(filename);
  if (process.env.OMARKD_SCREENSHOTS === "1") await mkdir(resolve("assets/screenshots"), { recursive: true });
  await page.screenshot({ path, animations: "disabled" });
  await info.attach("Feature screenshot", { path, contentType: "image/png" });
});

test("welcome", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Omarkd", exact: true })).toBeVisible();
  await expect(page.locator(".welcome .logo")).toBeVisible();
  expect(await page.locator(".welcome .logo").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole("button", { name: "Find", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Open a file" }).click();
  await expect(page.locator(".welcome")).toBeVisible();
  expect(await commandCount(page, "plugin:dialog|open")).toBe(1);
  await expect.poll(() => commandCount(page, "plugin:window|show")).toBe(1);
  expect(await commandCount(page, "plugin:window|set_focus")).toBe(1);
});

test("markdown", async ({ page }) => {
  await openDocument(page);
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
  await expect(page.locator("#content strong")).toHaveText("fast");
  await expect(page.locator("#content em")).toHaveText("modern");
  await expect(page.locator("#content del")).toHaveText("plain");
  await expect(page.locator("#content sup").first()).toHaveText("superscript");
  await expect(page.locator("#content code")).toHaveText("inline code");
  await expect(page.locator("#content .markdown-alert-note")).toContainText("Native rendering");
  await expect(page.locator('#content input[type="checkbox"]')).toHaveCount(2);
  await expect(page.locator('#content input[type="checkbox"]').first()).toBeChecked();
  await expect(page.locator("#content table tbody tr")).toHaveCount(3);
  await expect(page.locator("#content dt")).toHaveText("Reader");
  await expect(page.locator("#content dd")).toContainText("focused");
  await expect(page.locator("#content .footnotes")).toContainText("renders Markdown in Rust");
  await expect(page.getByRole("link", { name: "Wiki link" })).toHaveAttribute("href", "second.md");
  await expect(page.locator("#content")).not.toContainText("hidden front matter");
  await expect(page.locator("#status")).toHaveText("1.0 ms");
});

test("code-and-copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openDocument(page, "code");
  await expect(page.locator("#content pre")).toHaveCount(5);
  await expect(page.locator("#content .sx-source.sx-ts")).toHaveCount(1);
  await expect(page.locator("#content .sx-keyword").first()).toBeAttached();
  await expect(page.locator("#content pre").last()).toContainText("This stays readable");
  const first = page.locator("#content pre").first();
  await first.hover();
  await first.getByRole("button", { name: "Copy code" }).click();
  await expect(first.getByRole("button", { name: "Copy code" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('let message = "Hello, Omarkd!";');
  await expect(first.getByRole("button", { name: "Copy code" })).toHaveText("Copy");
  const color = await page.locator("#content .sx-keyword").first().evaluate(el => getComputedStyle(el).color);
  expect(color).not.toBe(await page.locator("#content").evaluate(el => getComputedStyle(el).color));
});

test("math", async ({ page }) => {
  await openDocument(page, "math");
  await expect(page.locator("#content math")).toHaveCount(3);
  await expect(page.locator(".math-inline math")).toHaveCount(1);
  await expect(page.locator(".math-display math")).toHaveCount(2);
  await expect(page.locator("[data-math-style]")).toHaveCount(0);
  await expect(page.locator("#content pre")).toHaveCount(0);
});

test("diagrams", async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  await openDocument(page, "diagrams");
  await expect(page.locator("pre.mermaid svg")).toBeVisible();
  await expect(page.locator("pre.mermaid")).toContainText("Beautiful reading");
  await expect(page.locator("pre.mermaid button.copy")).toHaveCount(0);
});

test("safe-html-and-images", async ({ page }) => {
  await openDocument(page, "html");
  await page.getByText("Expand the details", { exact: true }).click();
  await expect(page.getByText("Embedded HTML remains useful and readable.")).toBeVisible();
  await expect(page.locator("#content math")).toBeVisible();
  await expect(page.getByRole("img", { name: "Omarkd diagram" })).toBeVisible();
  expect(await page.getByRole("img", { name: "Omarkd diagram" }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator("#content script, #content iframe, #content [onerror]")).toHaveCount(0);
  await expect(page.getByText("Unsafe link without an active URL")).not.toHaveAttribute("href");
  expect(await page.evaluate(() => "omarkdInjected" in window)).toBe(false);
});

test("outline", async ({ page }) => {
  await openDocument(page, "code");
  await page.getByRole("button", { name: "Toggle outline" }).click();
  await expect(page.locator("#outline")).toBeVisible();
  await expect(page.locator("#outline a")).toHaveCount(6);
  await page.locator("#outline").getByRole("link", { name: "Unknown language" }).click();
  await expect(page.locator("#unknown-language")).toBeInViewport();
  await page.reload();
  await expect(page.locator("#outline")).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+O`);
  await expect(page.locator("#outline")).toBeHidden();
  await page.keyboard.press(`${mod}+Shift+O`);
});

test("document-navigation", async ({ page }) => {
  await openDocument(page);
  await page.getByRole("link", { name: "Second document", exact: true }).click();
  await expect(page.locator("#content h1")).toHaveText("Second document");
  await expect(page.locator("#details")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
  await page.keyboard.press(`${mod}+]`);
  await expect(page.locator("#content h1")).toHaveText("Second document");
  await page.keyboard.press(`${mod}+[`);
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
  await page.getByRole("link", { name: "Encoded heading" }).click();
  await expect(page.locator("#keep-exploring")).toBeInViewport();
});

test("open-files", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { window.omarkdTest.dialogResult = ["/documents/reader.md", "/documents/second.md"]; });
  await page.keyboard.press(`${mod}+O`);
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
  const opened = await page.evaluate(() => window.omarkdTest.calls.find(call => call.command === "open_in_new_window"));
  expect(opened?.args.path).toBe("/documents/second.md");
  await page.evaluate(() => { window.omarkdTest.dialogResult = "/documents/code.md"; });
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(page.locator("#content h1")).toHaveText("Code that reads like code");
  const options = await page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "plugin:dialog|open").at(-1)?.args);
  expect(options).toMatchObject({ options: { multiple: true, directory: false, defaultPath: "/documents" } });
});

test("drag-and-drop", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.omarkdTest.calls.filter(call => call.args.event === "tauri://drag-drop").length)).toBe(1);
  await page.evaluate(() => window.omarkdTest.emit("tauri://drag-enter", { paths: ["/documents/reader.md"], position: { x: 100, y: 100 } }));
  await expect(page.locator("body")).toHaveClass(/drag-over/);
  await page.evaluate(() => window.omarkdTest.emit("tauri://drag-drop", { paths: ["/documents/reader.md", "/documents/second.md", "/documents/ignore.txt"], position: { x: 100, y: 100 } }));
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
  await expect(page.locator("body")).not.toHaveClass(/drag-over/);
  expect(await commandCount(page, "open_in_new_window")).toBe(1);
  await page.evaluate(() => window.omarkdTest.emit("tauri://drag-leave", null));
});

test("find", async ({ page }) => {
  await openDocument(page);
  await page.getByRole("button", { name: "Find", exact: true }).click();
  const input = page.locator("#find-input");
  await expect(input).toBeFocused();
  await input.fill("Markdown");
  await input.press("Enter");
  await expect(input).not.toHaveClass(/not-found/);
  const selection = () => page.evaluate(() => {
    const selected = window.getSelection();
    return {
      text: selected?.toString(),
      anchor: selected?.anchorNode?.parentElement?.outerHTML,
      offset: selected?.anchorOffset,
    };
  });
  const first = await selection();
  expect(first.text).toBe("Markdown");
  await input.press("Enter");
  const next = await selection();
  expect(next.text).toBe("Markdown");
  expect(next).not.toEqual(first);
  await input.press("Shift+Enter");
  expect(await selection()).toEqual(first);
  await input.fill("not-present-omarkd-text");
  await input.press("Enter");
  await expect(input).toHaveClass(/not-found/);
  await input.fill("Rust");
  await expect(input).not.toHaveClass(/not-found/);
  await input.press("Escape");
  await expect(page.locator("#findbar")).toBeHidden();
  await page.keyboard.press(`${mod}+F`);
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(page.locator("#doc-path")).toHaveText("/documents/reader.md");
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
  await page.locator("#content h1").scrollIntoViewIfNeeded();
  await expect(page.locator("#content h1")).toBeInViewport();
  // Capture the find controls without browser-native selection painting.
  await page.reload();
  await expect(page.locator("#content h1")).toBeVisible();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await input.fill("Markdown");
  await expect(input).toHaveValue("Markdown");
});

test("live-reload", async ({ page }) => {
  await openDocument(page, "code");
  await page.evaluate(() => { document.getElementById("scroller")!.scrollTop = 120; });
  await expect.poll(() => page.locator("#scroller").evaluate(el => el.scrollTop)).toBe(120);
  const before = await commandCount(page, "render_file");
  await page.evaluate(() => {
    window.omarkdTest.documents["/documents/code.md"].html += "<p id=\"updated\">Saved changes are live.</p>";
    window.omarkdTest.emit("omarkd://file-changed", null);
    window.omarkdTest.emit("omarkd://file-changed", null);
    window.omarkdTest.emit("omarkd://file-changed", null);
  });
  await expect(page.locator("#updated")).toBeAttached();
  expect(await commandCount(page, "render_file")).toBe(before + 1);
  await expect.poll(() => page.locator("#scroller").evaluate(el => el.scrollTop)).toBe(120);
  await page.keyboard.press(`${mod}+R`);
  await expect.poll(() => commandCount(page, "render_file")).toBe(before + 2);
  await expect.poll(() => page.locator("#scroller").evaluate(el => el.scrollTop)).toBe(120);
});

test("desktop-link-actions", async ({ page }) => {
  await openDocument(page);
  await page.getByRole("link", { name: "External website" }).click();
  await page.getByRole("link", { name: "Open attachment" }).click();
  await page.locator("#doc-path").click();
  await page.getByRole("link", { name: "Wiki link" }).click({ modifiers: [mod] });
  const calls = await page.evaluate(() => window.omarkdTest.calls);
  expect(calls).toContainEqual({ command: "plugin:opener|open_url", args: { url: "https://example.com" } });
  expect(calls).toContainEqual({ command: "plugin:opener|open_path", args: { path: "/documents/notes.txt" } });
  expect(calls).toContainEqual({ command: "plugin:opener|reveal_item_in_dir", args: { paths: ["/documents/reader.md"] } });
  expect(calls).toContainEqual({ command: "open_in_new_window", args: { path: "/documents/second.md" } });
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
});

test("errors", async ({ page }) => {
  await openDocument(page);
  await page.getByRole("link", { name: "Missing document" }).click();
  await expect(page.getByRole("heading", { name: "Could not open document" })).toBeVisible();
  await expect(page.locator(".load-error")).toContainText("/documents/missing.md");
  await expect(page.locator("#outline a")).toHaveCount(0);
  expect(await page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "plugin:window|set_title").at(-1)?.args.value)).toBe("Omarkd");
});

test("watch-errors", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.omarkdTest.watchError = "Permission denied";
    window.omarkdTest.dialogResult = "/documents/reader.md";
  });
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Live reload unavailable");
  await expect(page.locator("#status")).toHaveAttribute("title", /Permission denied/);
  await expect(page.locator("#content h1")).toHaveText("Read beautifully 🚀");
});

test("latest-document-wins", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.omarkdTest.calls.filter(call => call.args.event === "tauri://drag-drop").length)).toBe(1);
  await page.evaluate(() => {
    window.omarkdTest.delays["/documents/reader.md"] = 300;
    window.omarkdTest.emit("tauri://drag-drop", { paths: ["/documents/reader.md"], position: { x: 0, y: 0 } });
    window.omarkdTest.emit("tauri://drag-drop", { paths: ["/documents/second.md"], position: { x: 0, y: 0 } });
  });
  await expect(page.locator("#content h1")).toHaveText("Second document");
  await expect.poll(() => page.evaluate(() => window.omarkdTest.completedRenders.includes("/documents/reader.md"))).toBe(true);
  await expect(page.locator("#content h1")).toHaveText("Second document");
});

test("light-and-dark", async ({ page, context }) => {
  await openDocument(page, "diagrams");
  await expect(page.locator("pre.mermaid svg")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("title", "Switch to light mode");
  await expect(page.locator("pre.mermaid .node rect").first()).toHaveCSS("fill", "rgb(31, 32, 32)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("pre.mermaid svg")).toBeVisible();
  const sibling = await context.newPage();
  await sibling.goto("/");
  await expect(sibling.locator("html")).toHaveAttribute("data-theme", "dark");
  await sibling.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("pre.mermaid .node rect").first()).toHaveCSS("fill", "rgb(236, 236, 255)");
  await sibling.close();
  await toggle.click();
  await expect(page.locator("pre.mermaid .node rect").first()).toHaveCSS("fill", "rgb(31, 32, 32)");
});

test("system-theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openDocument(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("omarkd.theme"))).toBeNull();
  const themes = await page.evaluate(() => window.omarkdTest.calls.filter(call => call.command === "plugin:window|set_theme").map(call => call.args.value));
  expect(themes.every(theme => theme === null)).toBe(true);
});

test("compact-window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 640 });
  await openDocument(page);
  await expect(page.getByRole("button", { name: "Dark mode", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Open file", exact: true })).toBeInViewport();
  expect(await page.locator("body").evaluate(el => el.scrollWidth)).toBe(420);
  await expect(page.locator("#content")).toHaveCSS("padding-left", "18px");
});

test("dark-code", async ({ page }) => {
  await openDocument(page, "code");
  const keyword = page.locator("#content .sx-keyword").first();
  const lightColor = await keyword.evaluate(el => getComputedStyle(el).color);
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => keyword.evaluate(el => getComputedStyle(el).color)).not.toBe(lightColor);
  await expect(page.locator("#content")).toHaveCSS("color", "rgb(240, 246, 252)");
  await expect(page.locator("#content pre").first()).toHaveCSS("background-color", "rgb(21, 27, 35)");
  await expect(page.locator("#content pre > code").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("lazy-loading", async ({ page }) => {
  const heavyRequests: string[] = [];
  page.on("request", request => {
    if (/\/(?:mermaid|temml)(?:[._-].*)?\.js(?:\?|$)/.test(new URL(request.url()).pathname)) heavyRequests.push(request.url());
  });
  await openDocument(page);
  await expect.poll(() => commandCount(page, "plugin:window|show")).toBe(1);
  expect(heavyRequests).toEqual([]);
  await expect(page.locator("#content math, #content pre.mermaid")).toHaveCount(0);
});
