import { describe, expect, it } from "vitest";
import { isExternalUrl, isMarkdownPath, resolvePath, splitHref } from "../src/paths";

describe("Markdown paths", () => {
  // The recognized and rejected tables prevent suffix-only and case-sensitivity regressions.
  it.each(["a.md", "a.MARKDOWN", "a.mdown", "a.mkd", "a.mkdn", "a.mdx"])("recognizes %s", (path) => {
    expect(isMarkdownPath(path)).toBe(true);
  });
  it.each(["a.txt", "a.md.png", "a", ""])("rejects %s", (path) => {
    expect(isMarkdownPath(path)).toBe(false);
  });
});

describe("external URLs", () => {
  // URI schemes route to native handlers; file URLs and fragments stay in-document.
  it.each(["https://example.com", "http://example.com", "mailto:a@example.com", "custom+app:value"])("recognizes %s", (url) => {
    expect(isExternalUrl(url)).toBe(true);
  });
  it.each(["file:///docs/a.md", "FILE:///a.md", "../a.md", "#title", "/a.md"])("keeps %s local", (url) => {
    expect(isExternalUrl(url)).toBe(false);
  });
});

describe("path resolution", () => {
  // Expected strings specify normalization exactly, including root traversal and drive preservation.
  it.each([
    ["/docs", "./a.md", "/docs/a.md"],
    ["/docs/sub/", "../a%20b.md", "/docs/a b.md"],
    ["/docs", "/other/a.md", "/other/a.md"],
    ["/docs", "file:///other/a.md", "/other/a.md"],
    ["C:\\docs\\sub", "..\\a.md", "C:/docs/a.md"],
    ["/docs", "D:\\other\\a.md", "D:/other/a.md"],
    ["/docs", "bad%ZZ.md", "/docs/bad%ZZ.md"],
    ["/docs", "../../../a.md", "/a.md"],
    ["/docs", "文.md", "/docs/文.md"],
  ])("resolves %s + %s", (base, target, expected) => {
    expect(resolvePath(base, target)).toBe(expected);
  });
});

describe("link splitting", () => {
  // Queries are stripped only from the path; additional fragment hashes remain intact.
  it.each([
    ["a.md?view=1#hello", ["a.md", "hello"]],
    ["#hello", ["", "hello"]],
    ["a.md", ["a.md", ""]],
    ["a.md#one#two", ["a.md", "one#two"]],
    ["", ["", ""]],
  ])("splits %s", (href, expected) => {
    expect(splitHref(href)).toEqual(expected);
  });
});
/**
 * Pure routing tests: extension detection, URL classification and lexical paths.
 * Table-driven cases include Windows drives, Unicode, malformed percent escapes
 * and fragments; no filesystem access or native browser handlers are involved.
 * @packageDocumentation
 */
