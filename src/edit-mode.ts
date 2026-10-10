import { invoke } from "@tauri-apps/api/core";
import { Autosave, type SaveResult, type SaveState } from "./autosave";
import { getTheme } from "./theme";
import type { TextEditor } from "./text-editor";

export class EditMode {
  private editor: TextEditor | undefined;
  private autosave: Autosave | undefined;
  private path = "";
  private busy = false;
  active = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly message: HTMLElement,
    private readonly button: HTMLButtonElement,
    private readonly status: HTMLElement,
    private readonly onModeChange: () => void,
  ) {
    this.message.addEventListener("click", event => {
      const action = (event.target as Element).closest<HTMLButtonElement>("button")?.dataset.action;
      if (action) void this.resolve(action);
    });
  }

  get unsaved(): boolean {
    return this.autosave?.unsaved ?? false;
  }

  get transitioning(): boolean {
    return this.busy;
  }

  private display(state: SaveState): void {
    const labels = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving...", conflict: "Save conflict", error: "Save failed" };
    this.status.textContent = labels[state.kind];
    this.status.title = "";
    this.message.replaceChildren();
    this.message.hidden = state.kind !== "conflict" && state.kind !== "error";
    if (state.kind === "conflict" || state.kind === "error") {
      const text = document.createElement("span");
      text.textContent = state.kind === "conflict"
        ? "This file changed on disk. Your edits are kept here; autosave is paused."
        : `Could not save your edits: ${state.message}`;
      this.message.append(text);
      const actions = state.kind === "conflict"
        ? [["overwrite", "Overwrite disk with my edits"], ["reload", "Discard edits and reload disk"]]
        : [["retry", "Retry save"]];
      actions.push(["copy", "Copy my edits"]);
      for (const [action, label] of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.textContent = label;
        this.message.append(button);
      }
    }
  }

  async enter(path: string): Promise<void> {
    if (this.active || this.busy) return;
    this.busy = true;
    this.button.disabled = true;
    this.path = path;
    try {
      const [source, { createTextEditor }] = await Promise.all([
        invoke<string>("read_source", { path }),
        import("./text-editor"),
      ]);
      const session = new Autosave(source,
        (expected, source) => invoke<SaveResult>("save_source", { path, expected, source }),
        state => { if (this.autosave === session) this.display(state); });
      this.autosave = session;
      this.host.hidden = false;
      this.active = true;
      this.button.setAttribute("aria-pressed", "true");
      this.button.title = "Switch to view mode";
      document.body.classList.add("is-editing");
      this.editor = createTextEditor(this.host, source, getTheme() === "dark", source => this.autosave!.change(source));
      this.display({ kind: "saved" });
    } catch (error) {
      this.editor?.destroy();
      this.editor = undefined;
      this.autosave = undefined;
      this.active = false;
      this.host.hidden = true;
      document.body.classList.remove("is-editing");
      this.button.setAttribute("aria-pressed", "false");
      this.button.title = "Switch to edit mode";
      this.status.textContent = `Could not enter edit mode: ${String(error)}`;
      this.status.title = String(error);
      console.error("Could not enter edit mode", error);
      this.message.hidden = false;
      this.message.textContent = `Could not enter edit mode: ${String(error)}`;
    } finally {
      this.busy = false;
      this.button.disabled = false;
      this.onModeChange();
    }
  }

  async leave(): Promise<boolean> {
    if (this.busy) return false;
    if (!this.active) return true;
    this.busy = true;
    this.button.disabled = true;
    try {
      if (!await this.autosave!.flush()) return false;
      this.editor!.destroy();
      this.editor = undefined;
      this.autosave = undefined;
      this.active = false;
      this.host.hidden = true;
      this.message.hidden = true;
      document.body.classList.remove("is-editing");
      this.button.setAttribute("aria-pressed", "false");
      this.button.title = "Switch to edit mode";
      this.onModeChange();
      return true;
    } finally {
      this.busy = false;
      this.button.disabled = false;
    }
  }

  setTheme(): void {
    this.editor?.setTheme(getTheme() === "dark");
  }

  find(): void {
    this.editor?.find();
  }

  closeFind(): void {
    this.editor?.closeFind();
  }

  async refresh(): Promise<void> {
    if (!this.active || this.busy) return;
    const session = this.autosave!;
    try {
      // Drain in-flight saves before reading the disk, including our watcher events.
      await session.flush();
      const revision = session.revision;
      const source = await invoke<string>("read_source", { path: this.path });
      if (this.autosave !== session) return;
      const replace = await session.reconcile(source, revision);
      if (this.autosave === session && replace) this.editor!.replace(source);
    } catch (error) {
      if (this.autosave === session) session.fail(String(error));
      console.error("Could not refresh editor source", error);
    }
  }

  async save(): Promise<boolean> {
    return this.autosave ? this.autosave.flush() : true;
  }

  private async resolve(action: string): Promise<void> {
    if (this.busy || !this.autosave) return;
    this.busy = true;
    try {
      if (action === "overwrite") await this.autosave.overwrite();
      else if (action === "retry") await this.autosave.retry();
      else if (action === "copy") await navigator.clipboard.writeText(this.autosave.source);
      else if (action === "reload") {
        const source = await invoke<string>("read_source", { path: this.path });
        this.autosave.discard(source);
        this.editor!.replace(source);
      }
    } catch (error) {
      console.error("Could not resolve editor save", error);
      this.status.textContent = `Editor action failed: ${String(error)}`;
    } finally {
      this.busy = false;
    }
  }
}
