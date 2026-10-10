// Heavy renderers are imported on demand so documents without math or diagrams
// never pay for them.

import { getTheme } from "./theme";

let mathMacros: Record<string, unknown> = {};

export async function renderMath(root: HTMLElement): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>("[data-math-style]");
  if (nodes.length === 0) return;
  const temml = (await import("temml")).default;
  mathMacros = {};
  for (const node of nodes) {
    const display = node.dataset.mathStyle === "display";
    // ```math blocks render as <pre><code data-math-style>; replace the whole <pre>.
    const host = node.parentElement?.tagName === "PRE" ? node.parentElement : node;
    const target = document.createElement(display ? "div" : "span");
    target.className = display ? "math-display" : "math-inline";
    try {
      temml.render(node.textContent ?? "", target, {
        displayMode: display,
        throwOnError: false,
        macros: mathMacros,
        annotate: true,
      });
      host.replaceWith(target);
    } catch (e) {
      node.title = String(e);
      node.classList.add("math-error");
    }
  }
}

let mermaidReady: Promise<typeof import("mermaid").default> | undefined;

export async function renderMermaid(root: HTMLElement): Promise<void> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("pre.mermaid"));
  if (nodes.length === 0) return;
  mermaidReady ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidReady;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: getTheme() === "dark" ? "dark" : "default",
    fontFamily: "inherit",
  });
  await mermaid.run({ nodes, suppressErrors: true });
}

export function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre:not(.mermaid)")) {
    if (!pre.querySelector("code")) continue;
    const button = document.createElement("button");
    button.className = "copy";
    button.type = "button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    pre.append(button);
  }
}

export function handleCopyClick(event: MouseEvent): boolean {
  const button = (event.target as Element).closest?.("button.copy");
  if (!button) return false;
  const code = button.parentElement?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1200);
  });
  return true;
}

export function buildOutline(root: HTMLElement, nav: HTMLElement): void {
  const headings = root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id]");
  const list = document.createElement("ol");
  for (const h of headings) {
    const li = document.createElement("li");
    li.className = `lvl-${h.tagName[1]}`;
    const a = document.createElement("a");
    a.href = `#${encodeURIComponent(h.id)}`;
    a.textContent = h.textContent?.trim() ?? "";
    li.append(a);
    list.append(li);
  }
  nav.replaceChildren(list);
  nav.classList.toggle("empty", headings.length === 0);
}
