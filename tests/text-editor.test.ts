import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { createTextEditor } from "../src/text-editor";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  document.body.innerHTML = "<div id=\"host\"></div>";
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});
afterEach(() => vi.unstubAllGlobals());

it("provides Markdown syntax, line numbers, history, themes, search and source replacement", () => {
  const changed = vi.fn();
  const host = document.getElementById("host")!;
  const editor = createTextEditor(host, "# Title\n\n**Text**", false, changed);
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
  expect(host.querySelector(".cm-lineNumbers")).not.toBeNull();
  expect(host.querySelector('[aria-label="Markdown editor"]')).not.toBeNull();
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nEdited" } });
  expect(changed).toHaveBeenLastCalledWith("# Title\n\n**Text**\nEdited");
  editor.setTheme(true);
  editor.find();
  expect(host.querySelector(".cm-search")).not.toBeNull();
  editor.closeFind();
  expect(host.querySelector(".cm-search")).toBeNull();
  editor.replace("# Fresh");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(view.state.doc.toString()).toBe("# Fresh");
  editor.focus();
  editor.destroy();
  expect(host.children).toHaveLength(0);
});

it("preserves a BOM and CRLF line endings when editing and replacing text", () => {
  const changed = vi.fn();
  const host = document.getElementById("host")!;
  const editor = createTextEditor(host, "\uFEFF# Title\r\nText\r\n", true, changed);
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
  view.dispatch({ changes: { from: 0, to: 7, insert: "# Edit" } });
  expect(changed).toHaveBeenLastCalledWith("\uFEFF# Edit\r\nText\r\n");
  editor.replace("\uFEFF# Fresh\r\nNew\r\n");
  view.dispatch({ changes: { from: 7, insert: "!" } });
  expect(changed.mock.calls.at(-1)![0]).toContain("\uFEFF");
  expect(changed.mock.calls.at(-1)![0]).toContain("\r\n");
  editor.replace("# LF\nNew");
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nLast" } });
  expect(changed).toHaveBeenLastCalledWith("# LF\nNew\nLast");
  editor.replace("\uFEFF# Mixed\r\nFirst\nSecond");
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\nLast" } });
  expect(changed).toHaveBeenLastCalledWith("\uFEFF# Mixed\r\nFirst\r\nSecond\r\nLast");
  editor.destroy();
});
