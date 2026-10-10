import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Mutable OS signal exposed through the mocked matchMedia.matches getter. */
let dark = false;
/** Captured media-query listener so tests can simulate an OS palette change. */
let systemChange: (() => void) | undefined;
/** Captured storage listener simulating events delivered to a sibling window. */
let storageChange: ((event: StorageEvent) => void) | undefined;

beforeEach(() => {
  // Reset both module-level preference and DOM styling to avoid cross-test persistence.
  vi.resetModules();
  localStorage.clear();
  document.head.innerHTML = "<style id=\"app-style\">body{margin:0}</style>";
  document.body.innerHTML = "<button id=\"theme\"></button>";
  delete document.documentElement.dataset.theme;
  dark = false;
  systemChange = undefined;
  storageChange = undefined;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return dark; },
    addEventListener: (_: string, callback: () => void) => { systemChange = callback; },
  })));
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback) => {
    if (type === "storage") storageChange = callback as (event: StorageEvent) => void;
  });
});

afterEach(() => vi.unstubAllGlobals());

/** Imports fresh theme state and wires a real toolbar button plus native-theme spy. */
async function setup() {
  const theme = await import("../src/theme");
  const button = document.querySelector<HTMLButtonElement>("#theme")!;
  const change = vi.fn();
  theme.initializeTheme(button, change);
  return { ...theme, button, change };
}

describe("theme preference", () => {
  /** An absent preference follows OS changes without persisting a manual choice. */
  it("follows the system by default and leaves native preference unset", async () => {
    const { getTheme, button, change } = await setup();
    expect(getTheme()).toBe("light");
    expect(change).toHaveBeenLastCalledWith(undefined);
    dark = true;
    systemChange!();
    expect(getTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.title).toBe("Switch to light mode");
    expect(localStorage.getItem("omarkd.theme")).toBeNull();
  });

  // Each stored palette is authoritative even when it disagrees with the mock OS.
  it.each(["light", "dark"])("restores stored %s mode", async (stored) => {
    localStorage.setItem("omarkd.theme", stored);
    const { getTheme, change } = await setup();
    expect(getTheme()).toBe(stored);
    expect(change).toHaveBeenLastCalledWith(stored);
  });

  /** Clicking selects a remembered palette; subsequent OS events cannot override it. */
  it("toggles, persists and ignores later system changes", async () => {
    const { getTheme, button, change } = await setup();
    button.click();
    expect(getTheme()).toBe("dark");
    expect(localStorage.getItem("omarkd.theme")).toBe("dark");
    dark = true;
    systemChange!();
    expect(change).toHaveBeenCalledTimes(2);
    button.click();
    expect(getTheme()).toBe("light");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.title).toBe("Switch to dark mode");
    dark = false;
    systemChange!();
    expect(change).toHaveBeenCalledTimes(3);
  });

  /** Unexpected storage values must not become invalid root data-theme values. */
  it("uses the system for invalid preferences", async () => {
    localStorage.setItem("omarkd.theme", "invalid");
    dark = true;
    expect((await setup()).getTheme()).toBe("dark");
  });

  /** Only matching localStorage events apply; clearing storage restores system-following mode. */
  it("synchronizes windows and returns to system mode when storage is cleared", async () => {
    const { getTheme, change } = await setup();
    localStorage.setItem("omarkd.theme", "dark");
    storageChange!(new StorageEvent("storage", { key: "omarkd.theme", storageArea: localStorage }));
    expect(getTheme()).toBe("dark");
    storageChange!(new StorageEvent("storage", { key: "unrelated", storageArea: localStorage }));
    storageChange!(new StorageEvent("storage", { key: "omarkd.theme", storageArea: sessionStorage }));
    expect(change).toHaveBeenCalledTimes(2);
    localStorage.clear();
    storageChange!(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(getTheme()).toBe("light");
    expect(change).toHaveBeenLastCalledWith(undefined);
  });

  /** Stylesheet order preserves app layout overrides when a theme sheet is injected. */
  it("places Markdown theme CSS before app layout overrides", async () => {
    await setup();
    expect(document.head.firstElementChild?.textContent).toContain(".markdown-body");
    expect(document.head.lastElementChild?.id).toBe("app-style");
  });
});
/**
 * Theme preference tests with a controlled OS media query and storage callbacks.
 * Module resets recreate the initial stored preference for every scenario.
 * Native window-theme behavior is represented by the onChange callback only.
 * @packageDocumentation
 */
