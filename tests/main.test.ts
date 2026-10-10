import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Native service spies and captured event callbacks installed before entry-module import. */
const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
  window: { setTheme: vi.fn(), setTitle: vi.fn(), show: vi.fn(), setFocus: vi.fn(), onDragDropEvent: vi.fn(), onCloseRequested: vi.fn(), destroy: vi.fn() },
  events: new Map<string, (event?: { payload: number }) => void>(),
}));
/** Heavy render calls resolve without loading math/diagram engines in controller tests. */
const renderers = vi.hoisted(() => ({ renderMath: vi.fn(), renderMermaid: vi.fn() }));
/** Editor facade records mode/search calls and exposes its onChange callback. */
const textEditor = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn(), replace: vi.fn(), setTheme: vi.fn(), find: vi.fn(), closeFind: vi.fn() }));
vi.mock("../src/text-editor", () => ({ createTextEditor: textEditor.create }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => native.window }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: native.openPath, openUrl: native.openUrl, revealItemInDir: native.revealItemInDir }));
vi.mock("../src/theme", () => ({
  initializeTheme: (_: HTMLButtonElement, change: (preference: undefined) => void) => change(undefined),
  getTheme: () => "light",
}));
vi.mock("../src/enhance", async importOriginal => ({
  ...await importOriginal<typeof import("../src/enhance")>(),
  ...renderers,
}));

/** Actual listeners registered by each fresh controller import, removed during teardown. */
const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
/** Small native response with deterministic timing and optional scenario-specific HTML. */
const doc = (path: string, html = '<h1 id="title">Title</h1><p>Text</p>') => ({
  path, dir: "/docs", title: path.split("/").at(-1), html, renderMs: 2.34,
});

beforeEach(() => {
  // Import reset recreates module state; the maintained HTML keeps toolbar IDs honest.
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  native.events.clear();
  history.replaceState(null, "", "/");
  document.head.innerHTML = "";
  document.body.className = "";
  document.body.inert = false;
  const html = readFileSync("index.html", "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  for (const target of [document, window]) {
    // Keep real event dispatch but record subscriptions so subsequent cases do not double-handle.
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      listeners.push([target, type, callback]);
      add(type, callback, options);
    });
  }
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  native.invoke.mockImplementation(async (command: string, args?: { path: string }) => {
    if (command === "highlight_css") return ".sx-code { color: red; }";
    if (command === "render_file") return doc(args!.path);
    if (command === "watch_file" || command === "open_in_new_window") return undefined;
    if (command === "read_source") return "# original";
    if (command === "save_source") return { kind: "saved" };
    if (command === "finish_quit") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
  for (const fn of Object.values(native.window)) fn.mockResolvedValue(undefined);
  native.listen.mockImplementation(async (event: string, callback: () => void) => { native.events.set(event, callback); });
  native.open.mockResolvedValue(null);
  renderers.renderMath.mockResolvedValue(undefined);
  renderers.renderMermaid.mockResolvedValue(undefined);
  textEditor.create.mockReturnValue(textEditor);
});

afterEach(() => {
  // Undo listeners and timers before the next import of this side-effectful entry module.
  for (const [target, type, callback] of listeners.splice(0)) target.removeEventListener(type, callback);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Starts a fresh controller with an optional initial file and drains immediate asynchronous work. */
async function start(path?: string) {
  if (path) history.replaceState(null, "", `/?file=${encodeURIComponent(path)}`);
  await import("../src/main");
  await vi.advanceTimersByTimeAsync(0);
}

/** Clicks a real DOM control and drains immediate command promises without advancing debounce time. */
async function click(id: string) {
  document.getElementById(id)!.click();
  await vi.advanceTimersByTimeAsync(0);
}

describe("application controller", () => {
  /** Welcome startup restores outline preference and reveals the native window after first paint. */
  it("shows the welcome screen, preserves outline preference, and paints before revealing the window", async () => {
    localStorage.setItem("omarkd.outline", "1");
    await start();
    expect(document.querySelector(".welcome h1")?.textContent).toBe("Omarkd");
    expect(document.body.classList.contains("is-empty")).toBe(true);
    expect(document.body.classList.contains("outline-visible")).toBe(true);
    expect(native.window.setTheme).toHaveBeenCalledWith(null);
    expect(native.window.show).toHaveBeenCalledOnce();
    expect(native.window.setFocus).toHaveBeenCalledOnce();
    expect(document.head.textContent).toContain(".sx-code");
  });

  /** Native rendering must be sanitized, enhanced, titled and watched before reader interaction. */
  it("loads initial files, sanitizes HTML, sets title and starts watching", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "render_file") return doc("/docs/one.md", '<h1 id="title">Title</h1><script>bad()</script><pre><code>code</code></pre>');
      if (command === "highlight_css") return "";
    });
    await start("/docs/one.md");
    expect(document.querySelector("#content script")).toBeNull();
    expect(document.querySelector("#content button.copy")).not.toBeNull();
    expect(document.querySelector("#outline a")?.getAttribute("href")).toBe("#title");
    expect(document.getElementById("status")?.textContent).toBe("2.3 ms");
    expect(native.window.setTitle).toHaveBeenCalledWith("one.md — Omarkd");
    expect(native.invoke).toHaveBeenCalledWith("watch_file", { path: "/docs/one.md" });
    expect(new URLSearchParams(location.search).get("file")).toBe("/docs/one.md");
    expect(renderers.renderMath).toHaveBeenCalledOnce();
    expect(renderers.renderMermaid).toHaveBeenCalledOnce();
  });

  /** Cancel leaves the view untouched; multi-select opens the first file here and the remainder elsewhere. */
  it("treats cancelled dialogs as no action and opens remaining files in new windows", async () => {
    await start();
    await click("btn-open");
    expect(native.invoke).not.toHaveBeenCalledWith("render_file", expect.anything());
    native.open.mockResolvedValueOnce(["/docs/one.md", "/docs/two.md"]);
    document.querySelector<HTMLButtonElement>(".welcome [data-action=open]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.invoke).toHaveBeenCalledWith("open_in_new_window", { path: "/docs/two.md" });
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/one.md");
    native.open.mockResolvedValueOnce("/docs/three.md");
    await click("btn-open");
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/three.md");
  });

  /** Even a failure string containing script markup is displayed inertly as diagnostic text. */
  it("reports load errors as text instead of HTML", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "render_file") throw new Error("<script>missing</script>");
      return "";
    });
    await start("/docs/missing.md");
    expect(document.querySelector(".load-error pre")?.textContent).toContain("<script>missing</script>");
    expect(document.querySelector("#content script")).toBeNull();
    expect(native.window.setTitle).toHaveBeenCalledWith("Omarkd");
  });

  /** Watch subscription failure is nonfatal for reading but must be visible and logged. */
  it("surfaces watcher failure while keeping the document readable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    native.invoke.mockImplementation(async (command: string, args?: { path: string }) => {
      if (command === "render_file") return doc(args!.path);
      if (command === "watch_file") throw new Error("watch failed");
      return "";
    });
    await start("/docs/one.md");
    expect(document.getElementById("status")?.textContent).toBe("Live reload unavailable");
    expect(document.getElementById("status")?.title).toContain("watch failed");
    expect(log).toHaveBeenCalledWith("Could not watch document", expect.any(Error));
    expect(document.querySelector("#content h1")).not.toBeNull();
  });

  /** Multiple file events in the 60 ms window cause one reload without resetting reader position. */
  it("debounces live reload and preserves scroll", async () => {
    await start("/docs/one.md");
    document.getElementById("scroller")!.scrollTop = 120;
    native.events.get("omarkd://file-changed")!();
    native.events.get("omarkd://file-changed")!();
    await vi.advanceTimersByTimeAsync(59);
    expect(native.invoke.mock.calls.filter(([command]) => command === "render_file")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(native.invoke.mock.calls.filter(([command]) => command === "render_file")).toHaveLength(2);
    expect(document.getElementById("scroller")!.scrollTop).toBe(120);
  });

  /** Post-render exceptions are logged while the successfully loaded base document remains usable. */
  it("keeps renderer failures explicit without losing document content", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    renderers.renderMath.mockRejectedValueOnce(new Error("math unavailable"));
    renderers.renderMermaid.mockRejectedValueOnce(new Error("diagram unavailable"));
    await start("/docs/one.md");
    expect(log).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#content h1")?.textContent).toBe("Title");
  });

  /** Browser-find arguments, temporary findbar hiding, no-match feedback and Escape are all wired. */
  it("handles find controls, no matches, reverse searches and Escape", async () => {
    const find = vi.fn().mockReturnValue(false);
    vi.stubGlobal("find", find);
    await start("/docs/one.md");
    await click("btn-find");
    const input = document.getElementById("find-input") as HTMLInputElement;
    input.value = "needle";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(find).toHaveBeenCalledWith("needle", false, true, true);
    expect(input.classList.contains("not-found")).toBe(true);
    input.dispatchEvent(new Event("input"));
    expect(input.classList.contains("not-found")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.getElementById("findbar")!.hidden).toBe(true);
  });

  /** Link classification determines which native opener is called without navigating the trusted webview. */
  it("routes links to external handlers, attachments, new windows and reveal", async () => {
    await start("/docs/one.md");
    document.getElementById("content")!.innerHTML += '<a id="external" href="https://example.com">External</a><a id="attachment" href="notes.txt">File</a><a id="new-window" href="two.md">Second</a>';
    await click("external");
    await click("attachment");
    document.getElementById("new-window")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, cancelable: true }));
    await click("doc-path");
    expect(native.openUrl).toHaveBeenCalledWith("https://example.com");
    expect(native.openPath).toHaveBeenCalledWith("/docs/notes.txt");
    expect(native.invoke).toHaveBeenCalledWith("open_in_new_window", { path: "/docs/two.md" });
    expect(native.revealItemInDir).toHaveBeenCalledWith("/docs/one.md");
  });

  /** Only handled keyboard combinations prevent defaults; unrelated input remains available. */
  it("handles shortcuts and ignores unrelated keys", async () => {
    await start();
    const key = (value: string, shiftKey = false) => {
      const event = new KeyboardEvent("keydown", { key: value, ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event;
    };
    expect(key("z").defaultPrevented).toBe(false);
    expect(key("o", true).defaultPrevented).toBe(true);
    expect(localStorage.getItem("omarkd.outline")).toBe("1");
    key("f");
    expect(document.getElementById("findbar")!.hidden).toBe(false);
    key("o");
    await vi.advanceTimersByTimeAsync(0);
    expect(native.open).toHaveBeenCalledOnce();
  });

  /** All history entry points share document/scroll stacks, including empty-stack no-ops. */
  it("navigates back and forward with toolbar, keyboard and mouse while restoring scroll", async () => {
    await start("/docs/one.md");
    await click("btn-back");
    await click("btn-forward");
    document.getElementById("scroller")!.scrollTop = 120;
    document.getElementById("content")!.innerHTML += '<a id="next" href="two.md">Second</a>';
    await click("next");
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/two.md");
    expect((document.getElementById("btn-back") as HTMLButtonElement).disabled).toBe(false);
    document.getElementById("scroller")!.scrollTop = 40;
    await click("btn-back");
    expect(document.getElementById("scroller")!.scrollTop).toBe(120);
    await click("btn-forward");
    expect(document.getElementById("scroller")!.scrollTop).toBe(40);
    document.dispatchEvent(new MouseEvent("mouseup", { button: 3 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/one.md");
    document.dispatchEvent(new MouseEvent("mouseup", { button: 4 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/two.md");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "[", ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "]", ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/two.md");
  });

  /** Fragment routing tolerates invalid encoding and legacy named anchors without redundant file loads. */
  it("jumps to encoded and legacy anchors and handles missing or malformed fragments", async () => {
    await start("/docs/one.md");
    document.getElementById("content")!.innerHTML += '<h2 id="hello world">Hello</h2><a name="legacy">Legacy</a><a id="encoded" href="#hello%20world">Encoded</a><a id="old" href="#legacy">Old</a><a id="malformed" href="#%ZZ">Malformed</a><a id="same" href="one.md#title">Same</a><a id="missing" href="one.md#absent">Missing</a>';
    await click("encoded");
    await click("old");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
    await click("malformed");
    await click("same");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(3);
    document.getElementById("scroller")!.scrollTop = 100;
    await click("missing");
    expect(document.getElementById("scroller")!.scrollTop).toBe(0);
    expect(native.invoke.mock.calls.filter(([command]) => command === "render_file")).toHaveLength(1);
  });

  /** Emulated native drag callbacks test the visual state and file filtering, not real OS drag delivery. */
  it("handles native drag states, filters Markdown files, and falls back for other dropped paths", async () => {
    await start();
    const drag = native.window.onDragDropEvent.mock.calls[0][0];
    drag({ payload: { type: "enter" } });
    expect(document.body.classList.contains("drag-over")).toBe(true);
    drag({ payload: { type: "over" } });
    drag({ payload: { type: "leave" } });
    expect(document.body.classList.contains("drag-over")).toBe(false);
    drag({ payload: { type: "drop", paths: ["/docs/ignore.txt", "/docs/one.md", "/docs/two.md"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/one.md");
    expect(native.invoke).toHaveBeenCalledWith("open_in_new_window", { path: "/docs/two.md" });
    drag({ payload: { type: "drop", paths: ["/docs/notes.txt"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/notes.txt");
  });

  /** Deferred success/failure from older requests cannot overwrite the newest document or its status. */
  it("ignores stale successful and failed loads when a newer file has won", async () => {
    await start();
    let resolveFirst!: (value: ReturnType<typeof doc>) => void;
    let rejectSecond!: (error: Error) => void;
    native.invoke.mockImplementation(async (command: string, args?: { path: string }) => {
      if (command !== "render_file") return undefined;
      if (args!.path === "/docs/slow.md") return new Promise(resolve => { resolveFirst = resolve; });
      if (args!.path === "/docs/fail.md") return new Promise((_, reject) => { rejectSecond = reject; });
      return doc(args!.path);
    });
    const drag = native.window.onDragDropEvent.mock.calls[0][0];
    drag({ payload: { type: "drop", paths: ["/docs/slow.md"] } });
    drag({ payload: { type: "drop", paths: ["/docs/fail.md"] } });
    drag({ payload: { type: "drop", paths: ["/docs/latest.md"] } });
    await vi.advanceTimersByTimeAsync(0);
    resolveFirst(doc("/docs/slow.md"));
    rejectSecond(new Error("stale failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/latest.md");
    expect(document.querySelector(".load-error")).toBeNull();
  });

  /** The controller routes edit-mode shortcuts and flushes source before changing documents. */
  it("toggles edit/view, routes search and reload to the editor and saves before navigation", async () => {
    await start("/docs/one.md");
    await click("btn-edit");
    expect(document.body.classList.contains("is-editing")).toBe(true);
    expect(document.getElementById("editor-panel")!.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, shiftKey: true }));
    expect(document.body.classList.contains("outline-visible")).toBe(false);
    await click("btn-find");
    expect(textEditor.find).toHaveBeenCalledOnce();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    textEditor.create.mock.calls[0][3]("# saved");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(native.invoke).toHaveBeenCalledWith("save_source", expect.objectContaining({ source: "# saved" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(native.invoke).toHaveBeenCalledWith("read_source", { path: "/docs/one.md" });
    await click("btn-edit");
    expect(document.body.classList.contains("is-editing")).toBe(false);
    expect(textEditor.destroy).toHaveBeenCalledOnce();
    await click("btn-edit");
    native.open.mockResolvedValueOnce("/docs/two.md");
    await click("btn-open");
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/two.md");
    expect(document.body.classList.contains("is-editing")).toBe(false);
  });

  /** Unsaved failures preserve the editor across navigation/close/Quit until explicit retry succeeds. */
  it("blocks navigation and closing on save failure, guards unload and flushes before quit", async () => {
    await start("/docs/one.md");
    await click("btn-edit");
    native.invoke.mockRejectedValueOnce(new Error("save denied"));
    textEditor.create.mock.calls[0][3]("# unsaved");
    await click("btn-edit");
    expect(document.body.classList.contains("is-editing")).toBe(true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    native.open.mockResolvedValueOnce("/docs/two.md");
    await click("btn-open");
    expect(document.getElementById("doc-path")?.textContent).toBe("/docs/one.md");
    await click("btn-back");
    await click("btn-forward");
    expect(document.body.classList.contains("is-editing")).toBe(true);
    const close = native.window.onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    await close(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(native.window.destroy).not.toHaveBeenCalled();
    await native.events.get("omarkd://before-quit")!({ payload: 7 });
    expect(native.invoke).toHaveBeenCalledWith("finish_quit", { request: 7, saved: false });
    expect(document.body.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }));
    native.events.get("omarkd://quit-cancelled")!({ payload: 6 });
    expect(document.body.inert).toBe(true);
    native.events.get("omarkd://quit-cancelled")!({ payload: 7 });
    expect(document.body.inert).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    await close(event);
    expect(native.window.destroy).toHaveBeenCalledOnce();
  });

  /** Clean close proceeds; stale cancelled quits are ignored and command errors restore interaction. */
  it("lets clean native close proceed and reports quit callback failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await start();
    await click("btn-edit");
    const close = native.window.onCloseRequested.mock.calls[0][0];
    const event = { preventDefault: vi.fn() };
    await close(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    native.events.get("omarkd://quit-cancelled")!({ payload: 7 });
    await native.events.get("omarkd://before-quit")!({ payload: 7 });
    expect(native.invoke).not.toHaveBeenCalledWith("finish_quit", { request: 7, saved: true });
    expect(document.body.inert).toBe(false);
    native.invoke.mockRejectedValueOnce(new Error("quit denied"));
    await native.events.get("omarkd://before-quit")!({ payload: 8 });
    expect(log).toHaveBeenCalledWith("Could not complete quit request", expect.any(Error));
  });
});
/**
 * Whole-webview controller tests using the maintained index.html and jsdom.
 * Native commands/events, heavy renderers and CodeMirror are mocked at their
 * boundaries. Real DOM routing, sanitizer, history and save queue still execute.
 * Fake time controls startup/reload/autosave; deferred promises force load races.
 * @packageDocumentation
 */
