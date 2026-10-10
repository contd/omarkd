/**
 * Persisted theme selection, system defaults and cross-window synchronization.
 * @packageDocumentation
 */
import lightCss from "github-markdown-css/github-markdown-light.css?inline";
import darkCss from "github-markdown-css/github-markdown-dark.css?inline";

/** App palette; an undefined preference means follow the system instead. */
type Theme = "light" | "dark";

/** Shared localStorage key used by all document windows. */
const storageKey = "omarkd.theme";
/** System palette signal, consulted only until a manual choice is stored. */
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
/** Manual selection, or undefined when the operating system remains authoritative. */
let preference = readPreference();

/** Accepts only recognized persisted palettes; invalid values use the system default. */
function readPreference(): Theme | undefined {
  const stored = localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : undefined;
}

/** Returns the effective palette, resolving an absent manual choice against the OS. */
export function getTheme(): Theme {
  return preference ?? (systemTheme.matches ? "dark" : "light");
}

/**
 * Installs Markdown palette CSS and listens for toolbar, OS and storage changes.
 * @param button - Sun/moon toolbar toggle whose title and pressed state are updated.
 * @param onChange - Called after applying each palette; undefined requests native OS-following.
 */
export function initializeTheme(button: HTMLButtonElement, onChange: (preference: Theme | undefined) => void): void {
  const markdownStyle = document.createElement("style");
  // Keep the app's layout overrides after the Markdown stylesheet.
  document.head.insertBefore(markdownStyle, document.head.querySelector("style, link[rel=stylesheet]"));

  /** Applies effective colors while reporting the actual preference to native theme wiring. */
  function applyTheme() {
    const theme = getTheme();
    document.documentElement.dataset.theme = theme;
    markdownStyle.textContent = theme === "dark" ? darkCss : lightCss;
    button.setAttribute("aria-pressed", String(theme === "dark"));
    button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    onChange(preference);
  }

  button.addEventListener("click", () => {
    preference = getTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, preference);
    applyTheme();
  });
  systemTheme.addEventListener("change", () => {
    if (preference === undefined) applyTheme();
  });
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
    preference = readPreference();
    applyTheme();
  });
  applyTheme();
}
