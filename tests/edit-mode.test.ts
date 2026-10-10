import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const editor = vi.hoisted(() => ({
  create: vi.fn(), destroy: vi.fn(), replace: vi.fn(), setTheme: vi.fn(), find: vi.fn(), closeFind: vi.fn(), focus: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("../src/theme", () => ({ getTheme: () => "dark" }));
vi.mock("../src/text-editor", () => ({ createTextEditor: editor.create }));
import { EditMode } from "../src/edit-mode";

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="host"></div><div id="message"></div><button id="edit"></button><span id="status"></span>';
  document.body.className = "";
  editor.create.mockReturnValue(editor);
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "read_source") return "# original";
    if (command === "save_source") return { kind: "saved" };
    throw new Error("Unknown command");
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => vi.useRealTimers());

function setup() {
  const status = document.getElementById("status")!;
  const message = document.getElementById("message")!;
  const changed = vi.fn();
  const mode = new EditMode(document.getElementById("host")!, message, document.getElementById("edit") as HTMLButtonElement, status, changed);
  const change = (source: string) => editor.create.mock.calls.at(-1)![3](source);
  const action = async (name: string) => {
    message.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { mode, status, message, changed, change, action };
}

describe("edit mode", () => {
  it("opens lazily, updates theme and find, saves before viewing and destroys the editor", async () => {
    const { mode, status, changed, change } = setup();
    expect(await mode.save()).toBe(true);
    expect(await mode.leave()).toBe(true);
    mode.setTheme(); mode.find(); mode.closeFind();
    await mode.refresh();
    await mode.enter("/docs/a.md");
    await mode.enter("/docs/a.md");
    expect(mode.active).toBe(true);
    expect(document.body.classList.contains("is-editing")).toBe(true);
    expect(editor.create).toHaveBeenCalledOnce();
    mode.setTheme(); mode.find(); mode.closeFind();
    expect(editor.setTheme).toHaveBeenCalledWith(true);
    expect(editor.find).toHaveBeenCalledOnce();
    expect(editor.closeFind).toHaveBeenCalledOnce();
    change("# changed");
    expect(mode.unsaved).toBe(true);
    expect(await mode.leave()).toBe(true);
    expect(native.invoke).toHaveBeenCalledWith("save_source", { path: "/docs/a.md", expected: "# original", source: "# changed" });
    expect(editor.destroy).toHaveBeenCalledOnce();
    expect(mode.active).toBe(false);
    expect(status.textContent).toBe("Saved");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("keeps unsaved text and blocks leaving until a conflict is explicitly resolved", async () => {
    const { mode, change, action, message } = setup();
    await mode.enter("/docs/a.md");
    native.invoke.mockResolvedValueOnce({ kind: "conflict", source: "# disk" });
    change("# mine");
    expect(await mode.leave()).toBe(false);
    expect(mode.active).toBe(true);
    expect(message.textContent).toContain("autosave is paused");
    await action("copy");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("# mine");
    await action("overwrite");
    expect(native.invoke).toHaveBeenCalledWith("save_source", { path: "/docs/a.md", expected: "# disk", source: "# mine" });
    expect(await mode.save()).toBe(true);
    expect(await mode.leave()).toBe(true);
  });

  it("allows explicit discard and replaces the editor with fresh disk contents", async () => {
    const { mode, change, action } = setup();
    await mode.enter("/docs/a.md");
    native.invoke.mockResolvedValueOnce({ kind: "conflict", source: "# disk" });
    change("# mine");
    await mode.save();
    native.invoke.mockResolvedValueOnce("# newest disk");
    await action("reload");
    expect(editor.replace).toHaveBeenCalledWith("# newest disk");
    expect(mode.unsaved).toBe(false);
  });

  it("shows read and editor creation failures without enabling edit mode", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mode, status, message } = setup();
    native.invoke.mockRejectedValueOnce(new Error("not UTF-8"));
    await mode.enter("/docs/a.md");
    expect(mode.active).toBe(false);
    expect(status.title).toContain("not UTF-8");
    expect(message.textContent).toContain("Could not enter edit mode");
    editor.create.mockImplementationOnce(() => { throw new Error("editor failed"); });
    await mode.enter("/docs/a.md");
    expect(mode.active).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("shows errors and supports retry while preserving text", async () => {
    const { mode, change, action, message } = setup();
    await mode.enter("/docs/a.md");
    native.invoke.mockRejectedValueOnce(new Error("permission denied"));
    change("# mine");
    expect(await mode.save()).toBe(false);
    expect(message.textContent).toContain("permission denied");
    await action("retry");
    expect(mode.unsaved).toBe(false);
    expect(message.hidden).toBe(true);
  });

  it("refreshes clean external changes and pauses saves when source cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mode, message } = setup();
    await mode.enter("/docs/a.md");
    native.invoke.mockResolvedValueOnce("# external");
    await mode.refresh();
    expect(editor.replace).toHaveBeenCalledWith("# external");
    native.invoke.mockRejectedValueOnce(new Error("deleted"));
    await mode.refresh();
    expect(message.textContent).toContain("deleted");
    expect(await mode.leave()).toBe(false);
  });

  it("does not replace local edits with an external conflict", async () => {
    const { mode, change } = setup();
    await mode.enter("/docs/a.md");
    native.invoke.mockResolvedValueOnce({ kind: "conflict", source: "# external" });
    native.invoke.mockResolvedValueOnce("# external");
    change("# mine");
    await mode.refresh();
    expect(editor.replace).not.toHaveBeenCalled();
    expect(mode.unsaved).toBe(true);
  });

  it("guards simultaneous entry, leaving and refresh while the editor is loading", async () => {
    let read!: (source: string) => void;
    const { mode } = setup();
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { read = resolve; }));
    const entering = mode.enter("/docs/a.md");
    await mode.enter("/docs/b.md");
    expect(await mode.leave()).toBe(false);
    await mode.refresh();
    read("# original");
    await entering;
    expect(editor.create).toHaveBeenCalledOnce();
  });

  it("reports action errors and ignores non-actions or actions without a session", async () => {
    const { mode, change, message, action, status } = setup();
    message.innerHTML = '<button data-action="copy">Copy</button>';
    await action("copy");
    message.click();
    await mode.enter("/docs/a.md");
    native.invoke.mockResolvedValueOnce({ kind: "conflict", source: "# disk" });
    change("# mine");
    await mode.save();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard blocked"));
    await action("copy");
    expect(status.textContent).toContain("clipboard blocked");
  });

  it("ignores delayed source reads after leaving or after a newer edit", async () => {
    const { mode, change, status } = setup();
    await mode.enter("/docs/a.md");
    let read!: (source: string) => void;
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { read = resolve; }));
    const refreshing = mode.refresh();
    await vi.advanceTimersByTimeAsync(0);
    await mode.leave();
    status.textContent = "Reader timing";
    read("# stale external source");
    await refreshing;
    expect(editor.replace).not.toHaveBeenCalled();
    expect(status.textContent).toBe("Reader timing");

    await mode.enter("/docs/a.md");
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { read = resolve; }));
    const secondRefresh = mode.refresh();
    await vi.advanceTimersByTimeAsync(0);
    change("# typed during source read");
    await mode.save();
    read("# original");
    await secondRefresh;
    expect(editor.replace).not.toHaveBeenCalled();
    expect(mode.unsaved).toBe(false);
    expect(status.textContent).toBe("Saved");
  });
});
