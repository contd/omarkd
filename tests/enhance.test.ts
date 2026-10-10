import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Import-time diagram seam records security/theme configuration and selected nodes. */
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) }));
/** Math renderer seam records options and can reject one expression deterministically. */
const temml = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../src/theme", () => ({ getTheme: () => "dark" }));
vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("temml", () => ({ default: temml }));

import { addCopyButtons, buildOutline, handleCopyClick, renderMath, renderMermaid } from "../src/enhance";

beforeEach(() => {
  // Preserve expression text in the fake renderer so DOM replacements remain observable.
  document.body.innerHTML = "";
  temml.render.mockImplementation((source: string, target: HTMLElement) => { target.textContent = source; });
});
afterEach(() => vi.useRealTimers());

describe("reader enhancements", () => {
  /** Only identified h1-h4 headings become safe-text, level-specific fragment links. */
  it("builds a heading outline with safe text, encoded anchors and levels", () => {
    const root = document.createElement("article");
    root.innerHTML = '<h1 id="hello world">Hello <em>world</em></h1><h3 id="three">Third</h3><h5 id="five">Ignored</h5><h2>No id</h2>';
    const nav = document.createElement("nav");
    buildOutline(root, nav);
    expect(nav.querySelectorAll("li")).toHaveLength(2);
    expect(nav.querySelector("a")?.getAttribute("href")).toBe("#hello%20world");
    expect(nav.querySelector("a")?.textContent).toBe("Hello world");
    expect(nav.querySelectorAll("li")[1].className).toBe("lvl-3");
    expect(nav.classList.contains("empty")).toBe(false);
    buildOutline(document.createElement("article"), nav);
    expect(nav.classList.contains("empty")).toBe(true);
    expect(nav.querySelectorAll("li")).toHaveLength(0);
  });

  /** Clipboard receives code text, not highlighted markup; Mermaid/plain pre blocks are excluded. */
  it("adds copy buttons only to code blocks and copies plain text", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const root = document.createElement("article");
    root.innerHTML = '<pre><code><span>const a = 1;</span></code></pre><pre class="mermaid"><code>graph TD</code></pre><pre>plain</pre>';
    document.body.append(root);
    addCopyButtons(root);
    const button = root.querySelector<HTMLButtonElement>("button")!;
    expect(root.querySelectorAll("button")).toHaveLength(1);
    button.addEventListener("click", handleCopyClick);
    button.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    expect(button.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1200);
    expect(button.textContent).toBe("Copy");
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: root });
    expect(handleCopyClick(event)).toBe(false);
  });

  /** Fenced math replaces its entire pre container, while inline and display forms get distinct hosts. */
  it("renders inline, display and fenced math and replaces the fenced pre", async () => {
    const root = document.createElement("article");
    root.innerHTML = '<code data-math-style="inline">x</code><code data-math-style="display">y</code><pre><code data-math-style="display">z</code></pre>';
    await renderMath(root);
    expect(root.querySelectorAll(".math-inline")).toHaveLength(1);
    expect(root.querySelectorAll(".math-display")).toHaveLength(2);
    expect(root.querySelector("pre")).toBeNull();
    expect(temml.render).toHaveBeenCalledTimes(3);
    expect(temml.render.mock.calls[0][2]).toMatchObject({ displayMode: false, throwOnError: false, annotate: true });
  });

  /** A renderer exception leaves source visible and adds diagnostic metadata to the original node. */
  it("marks math errors with the diagnostic and keeps source readable", async () => {
    temml.render.mockImplementationOnce(() => { throw new Error("invalid math"); });
    const root = document.createElement("article");
    root.innerHTML = '<code data-math-style="inline">bad</code>';
    await renderMath(root);
    expect(root.querySelector(".math-error")?.textContent).toBe("bad");
    expect(root.querySelector<HTMLElement>("code")?.title).toContain("invalid math");
  });

  /** Empty marker sets exit before either heavy renderer is invoked. */
  it("does not load heavy renderers for documents without math or diagrams", async () => {
    const root = document.createElement("article");
    await renderMath(root);
    await renderMermaid(root);
    expect(temml.render).not.toHaveBeenCalled();
    expect(mermaid.run).not.toHaveBeenCalled();
  });

  /** Diagrams use the app palette and strict security, not an independent system-theme lookup. */
  it("renders Mermaid in the active theme and strict mode", async () => {
    const root = document.createElement("article");
    root.innerHTML = '<pre class="mermaid">graph TD; A--&gt;B;</pre>';
    await renderMermaid(root);
    expect(mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: "inherit" });
    expect(mermaid.run).toHaveBeenCalledWith({ nodes: [root.firstElementChild], suppressErrors: true });
  });
});
/**
 * Reader DOM-enhancement tests with lazy math/diagram modules mocked at import.
 * Real outline/copy logic is exercised; E2E verifies actual Temml/Mermaid output.
 * Fake timers cover copy-feedback expiry without waiting on the wall clock.
 * @packageDocumentation
 */
