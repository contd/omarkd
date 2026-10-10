import lightCss from "github-markdown-css/github-markdown-light.css?inline";
import darkCss from "github-markdown-css/github-markdown-dark.css?inline";

type Theme = "light" | "dark";

const storageKey = "omarkd.theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
let preference = readPreference();

function readPreference(): Theme | undefined {
  const stored = localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : undefined;
}

export function getTheme(): Theme {
  return preference ?? (systemTheme.matches ? "dark" : "light");
}

export function initializeTheme(button: HTMLButtonElement, onChange: (preference: Theme | undefined) => void): void {
  const markdownStyle = document.createElement("style");
  // Keep the app's layout overrides after the Markdown stylesheet.
  document.head.insertBefore(markdownStyle, document.head.querySelector("style, link[rel=stylesheet]"));

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
