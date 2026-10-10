import { describe, expect, it } from "vitest";
import { sanitize } from "../src/sanitize";

/** Wraps a sanitized fragment for convenient DOM queries without changing production filtering. */
function element(html: string) {
  const root = document.createElement("div");
  root.append(sanitize(html));
  return root;
}

describe("HTML sanitizer", () => {
  // Each blocked tag is checked independently so the report identifies policy regressions.
  it.each(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "form", "noscript", "portal"])("removes %s", (tag) => {
    expect(element(`<${tag}>blocked</${tag}><p>safe</p>`).querySelector(tag)).toBeNull();
  });

  /** Passive rich-content structures and renderer metadata must survive the filtering pass. */
  it("preserves Markdown markup, details, SVG, MathML and data markers", () => {
    const root = element('<h1 id="a">Title</h1><details><summary>More</summary>Text</details><math><mi>x</mi></math><svg><path d="M0 0"/></svg><code class="sx-code" data-math-style="inline">x</code>');
    expect(root.querySelectorAll("h1, details, summary, math, mi, svg, path, code")).toHaveLength(8);
    expect(root.querySelector("code")?.getAttribute("data-math-style")).toBe("inline");
  });

  /** Verify both attribute removal and the absence of the fixture's execution marker. */
  it("strips event handlers without executing embedded scripts", () => {
    const root = element('<img src="safe.png" onerror="window.attacked=1"><script>window.attacked=1</script>');
    expect(root.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(root.querySelector("img")?.getAttribute("src")).toBe("safe.png");
    expect("attacked" in window).toBe(false);
  });

  // Case, whitespace and embedded control characters must not bypass active URL filtering.
  it.each(["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "vbscript:bad", "data:text/html,bad"])("strips dangerous URL %s", (url) => {
    const root = element(`<a href="${url}">link</a><img src="${url}">`);
    expect(root.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(root.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  // Useful local/remote links and passive image data remain unchanged.
  it.each(["https://example.com", "asset://localhost/a.png", "./second.md", "#heading", "data:image/png;base64,AAAA"])("preserves passive URL %s", (url) => {
    expect(element(`<a href="${url}">link</a>`).querySelector("a")?.getAttribute("href")).toBe(url);
  });
});
/**
 * HTML-filter regression tests in jsdom. Dangerous fixtures are parsed inertly;
 * assertions check removed nodes/attributes and retained passive Markdown markup.
 * This suite validates the app filter, not every possible HTML sanitization attack.
 * @packageDocumentation
 */
