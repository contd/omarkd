import "temml/dist/Temml-Local.css";
import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { addCopyButtons, buildOutline, handleCopyClick, renderMath, renderMermaid } from "./enhance";
import { isExternalUrl, isMarkdownPath, resolvePath, splitHref } from "./paths";
import { sanitize } from "./sanitize";
import { initializeTheme } from "./theme";
import { EditMode } from "./edit-mode";

interface RenderedDocument {
  path: string;
  dir: string;
  title: string;
  html: string;
  renderMs: number;
}

interface HistoryEntry {
  path: string;
  scroll: number;
}

const appWindow = getCurrentWebviewWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const content = $<HTMLElement>("content");
const scroller = $<HTMLElement>("scroller");
const outline = $<HTMLElement>("outline");
const status = $<HTMLElement>("status");
const docPath = $<HTMLButtonElement>("doc-path");
const findbar = $<HTMLElement>("findbar");
const findInput = $<HTMLInputElement>("find-input");
const backBtn = $<HTMLButtonElement>("btn-back");
const fwdBtn = $<HTMLButtonElement>("btn-forward");
const editBtn = $<HTMLButtonElement>("btn-edit");

let current: RenderedDocument | undefined;
let loadToken = 0;
let loading = false;
let transitioning = false;
let quitRequest: number | undefined;
let lastCancelledRequest = -1;
const back: HistoryEntry[] = [];
const forward: HistoryEntry[] = [];
const editing = new EditMode(
  $("editor-host"), $("editor-message"), editBtn, status,
  () => { $("editor-panel").hidden = !editing.active; updateNavButtons(); },
);

initializeTheme($<HTMLButtonElement>("btn-theme"), (preference) => {
  void appWindow.setTheme(preference ?? null).catch((e) => console.error("Could not update window theme", e));
  editing.setTheme();
  if (current && !editing.active && !editing.transitioning) void load(current.path, { keepScroll: true });
});

const highlightCss = invoke<string>("highlight_css").then((css) => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
});

function scrollToFragment(fragment: string): boolean {
  if (!fragment) return false;
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // use raw fragment
  }
  const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  return true;
}

function updateNavButtons() {
  backBtn.disabled = back.length === 0;
  fwdBtn.disabled = forward.length === 0;
  editBtn.disabled = !current || loading || transitioning || editing.transitioning;
  $<HTMLButtonElement>("btn-outline").disabled = editing.active;
}

function showError(message: string) {
  const box = document.createElement("div");
  box.className = "load-error";
  const title = document.createElement("h2");
  title.textContent = "Could not open document";
  const detail = document.createElement("pre");
  detail.textContent = message;
  box.append(title, detail);
  content.replaceChildren(box);
  outline.replaceChildren();
}

interface LoadOptions {
  keepScroll?: boolean;
  scroll?: number;
  fragment?: string;
}

async function load(path: string, opts: LoadOptions = {}): Promise<void> {
  const token = ++loadToken;
  loading = true;
  updateNavButtons();
  const previousScroll = scroller.scrollTop;
  let doc: RenderedDocument;
  try {
    doc = await invoke<RenderedDocument>("render_file", { path });
  } catch (e) {
    if (token !== loadToken) return;
    loading = false;
    current = undefined;
    updateNavButtons();
    showError(String(e));
    void appWindow.setTitle("Omarkd");
    return;
  }
  if (token !== loadToken) return;
  loading = false;

  const changedFile = current?.path !== doc.path;
  current = doc;
  updateNavButtons();
  content.replaceChildren(sanitize(doc.html));
  addCopyButtons(content);
  buildOutline(content, outline);
  document.body.classList.remove("is-empty");

  if (opts.keepScroll) scroller.scrollTop = previousScroll;
  else if (opts.scroll !== undefined) scroller.scrollTop = opts.scroll;
  else if (!scrollToFragment(opts.fragment ?? "")) scroller.scrollTop = 0;

  docPath.textContent = doc.path;
  status.textContent = `${doc.renderMs.toFixed(1)} ms`;
  if (changedFile) {
    void appWindow.setTitle(`${doc.title} — Omarkd`);
    void invoke("watch_file", { path: doc.path }).catch((e) => {
      status.textContent = "Live reload unavailable";
      status.title = String(e);
      console.error("Could not watch document", e);
    });
    const url = new URL(location.href);
    url.searchParams.set("file", doc.path);
    history.replaceState(null, "", url);
  }

  // Math is cheap and avoids flashing raw TeX; diagrams load in the background.
  const anchor = scroller.scrollTop;
  await renderMath(content).catch((e) => console.error(e));
  if (token !== loadToken) return;
  if (opts.keepScroll) scroller.scrollTop = anchor;
  void renderMermaid(content)
    .catch((e) => console.error(e))
    .then(() => {
      if (token === loadToken && opts.keepScroll) scroller.scrollTop = anchor;
    });
}

async function navigate(path: string, fragment = "") {
  if (!await leaveEditing()) return;
  if (current) {
    if (current.path === path) {
      scrollToFragment(fragment) || (scroller.scrollTop = 0);
      return;
    }
    back.push({ path: current.path, scroll: scroller.scrollTop });
    forward.length = 0;
  }
  updateNavButtons();
  await load(path, { fragment });
}

async function goBack() {
  if (!await leaveEditing()) return;
  const entry = back.pop();
  if (!entry) return;
  if (current) forward.push({ path: current.path, scroll: scroller.scrollTop });
  updateNavButtons();
  await load(entry.path, { scroll: entry.scroll });
}

async function goForward() {
  if (!await leaveEditing()) return;
  const entry = forward.pop();
  if (!entry) return;
  if (current) back.push({ path: current.path, scroll: scroller.scrollTop });
  updateNavButtons();
  await load(entry.path, { scroll: entry.scroll });
}

function showWelcome() {
  const tpl = document.getElementById("welcome") as HTMLTemplateElement;
  content.replaceChildren(tpl.content.cloneNode(true));
  outline.replaceChildren();
  document.body.classList.add("is-empty");
  docPath.textContent = "";
  status.textContent = "";
}

async function openDialog() {
  const selected = await open({
    multiple: true,
    directory: false,
    defaultPath: current?.dir,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "mdx"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
  await openPaths(paths);
}

/** Opens the first path here and any others in their own windows. */
async function openPaths(paths: string[]) {
  const [first, ...rest] = paths;
  if (!first) return;
  if (!await leaveEditing()) return;
  for (const p of rest) void invoke("open_in_new_window", { path: p });
  await navigate(first);
}

async function followLink(anchor: HTMLAnchorElement, newWindow: boolean) {
  const href = anchor.getAttribute("href");
  if (!href) return;
  if (href.startsWith("#")) {
    scrollToFragment(href.slice(1));
    return;
  }
  if (isExternalUrl(href)) {
    await openUrl(href);
    return;
  }
  if (!current) return;
  const [rel, fragment] = splitHref(href);
  const target = rel ? resolvePath(current.dir, rel) : current.path;
  if (isMarkdownPath(target)) {
    if (newWindow) await invoke("open_in_new_window", { path: target });
    else await navigate(target, fragment);
  } else {
    await openPath(target);
  }
}

function toggleOutline(force?: boolean) {
  if (editing.active) return;
  const visible = document.body.classList.toggle("outline-visible", force);
  localStorage.setItem("omarkd.outline", visible ? "1" : "0");
}

function toggleFind(show = findbar.hidden) {
  if (editing.active) {
    if (show) editing.find();
    else editing.closeFind();
    return;
  }
  findbar.hidden = !show;
  if (show) {
    findInput.focus();
    findInput.select();
  }
}

type FindableWindow = Window & {
  find?: (s: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean;
};

function findNext(backwards: boolean) {
  const query = findInput.value;
  if (!query) return;
  // Exclude the search field so the browser cannot match the query against itself.
  const wasHidden = findbar.hidden;
  findbar.hidden = true;
  let found: boolean;
  try {
    found = (window as FindableWindow).find?.(query, false, backwards, true) ?? false;
  } finally {
    findbar.hidden = wasHidden;
  }
  findInput.classList.toggle("not-found", !found);
  // window.find moves focus to the match; keep typing in the find box.
  findInput.focus();
}

// --- events -----------------------------------------------------------------

async function leaveEditing(): Promise<boolean> {
  if (!editing.active && !editing.transitioning && !transitioning) return true;
  if (transitioning) return false;
  transitioning = true;
  updateNavButtons();
  try {
    const wasEditing = editing.active;
    if (!await editing.leave()) return false;
    if (wasEditing && current) await load(current.path, { keepScroll: true });
    return true;
  } finally {
    transitioning = false;
    updateNavButtons();
  }
}

async function toggleEdit() {
  if (!current || loading || transitioning || editing.transitioning) return;
  if (editing.active) await leaveEditing();
  else {
    toggleFind(false);
    ++loadToken;
    await editing.enter(current.path);
  }
}

async function reloadDocument() {
  if (editing.transitioning) return;
  if (editing.active) await editing.refresh();
  else if (current) await load(current.path, { keepScroll: true });
}

document.addEventListener("click", (event) => {
  if (handleCopyClick(event)) return;
  const target = event.target as Element;
  if (target.closest("[data-action=open]")) {
    void openDialog();
    return;
  }
  const anchor = target.closest("a");
  if (anchor && (content.contains(anchor) || outline.contains(anchor))) {
    event.preventDefault();
    void followLink(anchor, event.metaKey || event.ctrlKey);
  }
});

// Mouse back/forward buttons.
document.addEventListener("mouseup", (event) => {
  if (event.button === 3) void goBack();
  if (event.button === 4) void goForward();
});

$("btn-outline").addEventListener("click", () => toggleOutline());
$("btn-open").addEventListener("click", () => void openDialog());
$("btn-find").addEventListener("click", () => toggleFind());
editBtn.addEventListener("click", () => void toggleEdit());
backBtn.addEventListener("click", () => void goBack());
fwdBtn.addEventListener("click", () => void goForward());
docPath.addEventListener("click", () => current && void revealItemInDir(current.path));

findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    findNext(event.shiftKey);
  } else if (event.key === "Escape") {
    toggleFind(false);
  }
});
findInput.addEventListener("input", () => findInput.classList.remove("not-found"));

document.addEventListener("keydown", (event) => {
  if (quitRequest !== undefined) {
    event.preventDefault();
    return;
  }
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (editing.active && ((mod && key === "g") || key === "escape")) return;
  if (mod && key === "o" && event.shiftKey) toggleOutline();
  else if (mod && key === "o") void openDialog();
  else if (mod && key === "f") toggleFind(true);
  else if (mod && key === "g") findNext(event.shiftKey);
  else if (mod && key === "r") void reloadDocument();
  else if (mod && key === "s" && editing.active) void editing.save();
  else if ((mod && key === "[") || (event.altKey && key === "arrowleft")) void goBack();
  else if ((mod && key === "]") || (event.altKey && key === "arrowright")) void goForward();
  else if (key === "escape" && !findbar.hidden) toggleFind(false);
  else return;
  event.preventDefault();
});

let reloadTimer: number | undefined;
void listen("omarkd://file-changed", () => {
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => void reloadDocument(), 60);
});

void appWindow.onCloseRequested(async event => {
  if (!editing.active && !editing.unsaved && !editing.transitioning) return;
  event.preventDefault();
  if (await editing.leave()) await appWindow.destroy();
});

void listen<number>("omarkd://quit-cancelled", event => {
  lastCancelledRequest = Math.max(lastCancelledRequest, event.payload);
  if (quitRequest !== event.payload) return;
  quitRequest = undefined;
  document.body.inert = false;
});

void listen<number>("omarkd://before-quit", async event => {
  if (event.payload <= lastCancelledRequest) return;
  quitRequest = event.payload;
  document.body.inert = true;
  const saved = await leaveEditing();
  await invoke("finish_quit", { request: event.payload, saved }).catch(e => {
    if (quitRequest === event.payload) {
      quitRequest = undefined;
      document.body.inert = false;
    }
    console.error("Could not complete quit request", e);
  });
});

window.addEventListener("beforeunload", event => {
  if (editing.unsaved) event.preventDefault();
});

void appWindow.onDragDropEvent((event) => {
  document.body.classList.toggle("drag-over", event.payload.type === "enter" || event.payload.type === "over");
  if (event.payload.type === "drop") {
    const paths = event.payload.paths.filter(isMarkdownPath);
    void openPaths(paths.length ? paths : event.payload.paths);
  }
});

// --- startup ------------------------------------------------------------------

if (localStorage.getItem("omarkd.outline") === "1") toggleOutline(true);

const initialFile = new URLSearchParams(location.search).get("file");
const firstPaint = initialFile ? load(initialFile) : (showWelcome(), Promise.resolve());

void Promise.race([
  Promise.all([highlightCss, firstPaint]),
  new Promise((resolve) => setTimeout(resolve, 800)),
]).finally(() => {
  requestAnimationFrame(() => {
    void appWindow.show();
    void appWindow.setFocus();
  });
});
