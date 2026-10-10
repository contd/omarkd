import { describe, expect, it } from "vitest";
import { sanitize } from "../src/sanitize";

function element(html: string) {
  const root = document.createElement("div");
  root.append(sanitize(html));
  return root;
}

describe("HTML sanitizer", () => {
  it.each(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "form", "noscript", "portal"])("removes %s", (tag) => {
    expect(element(`<${tag}>blocked</${tag}><p>safe</p>`).querySelector(tag)).toBeNull();
  });

  it("preserves Markdown markup, details, SVG, MathML and data markers", () => {
    const root = element('<h1 id="a">Title</h1><details><summary>More</summary>Text</details><math><mi>x</mi></math><svg><path d="M0 0"/></svg><code class="sx-code" data-math-style="inline">x</code>');
    expect(root.querySelectorAll("h1, details, summary, math, mi, svg, path, code")).toHaveLength(8);
    expect(root.querySelector("code")?.getAttribute("data-math-style")).toBe("inline");
  });

  it("strips event handlers without executing embedded scripts", () => {
    const root = element('<img src="safe.png" onerror="window.attacked=1"><script>window.attacked=1</script>');
    expect(root.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(root.querySelector("img")?.getAttribute("src")).toBe("safe.png");
    expect("attacked" in window).toBe(false);
  });

  it.each(["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "vbscript:bad", "data:text/html,bad"])("strips dangerous URL %s", (url) => {
    const root = element(`<a href="${url}">link</a><img src="${url}">`);
    expect(root.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(root.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it.each(["https://example.com", "asset://localhost/a.png", "./second.md", "#heading", "data:image/png;base64,AAAA"])("preserves passive URL %s", (url) => {
    expect(element(`<a href="${url}">link</a>`).querySelector("a")?.getAttribute("href")).toBe(url);
  });
});
