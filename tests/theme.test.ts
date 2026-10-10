import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dark = false;
let systemChange: (() => void) | undefined;
let storageChange: ((event: StorageEvent) => void) | undefined;

beforeEach(() => {
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

async function setup() {
  const theme = await import("../src/theme");
  const button = document.querySelector<HTMLButtonElement>("#theme")!;
  const change = vi.fn();
  theme.initializeTheme(button, change);
  return { ...theme, button, change };
}

describe("theme preference", () => {
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

  it.each(["light", "dark"])("restores stored %s mode", async (stored) => {
    localStorage.setItem("omarkd.theme", stored);
    const { getTheme, change } = await setup();
    expect(getTheme()).toBe(stored);
    expect(change).toHaveBeenLastCalledWith(stored);
  });

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

  it("uses the system for invalid preferences", async () => {
    localStorage.setItem("omarkd.theme", "invalid");
    dark = true;
    expect((await setup()).getTheme()).toBe("dark");
  });

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

  it("places Markdown theme CSS before app layout overrides", async () => {
    await setup();
    expect(document.head.firstElementChild?.textContent).toContain(".markdown-body");
    expect(document.head.lastElementChild?.id).toBe("app-style");
  });
});
