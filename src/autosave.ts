export type SaveResult = { kind: "saved" } | { kind: "conflict"; source: string };
export type SaveState =
  | { kind: "saved" | "dirty" | "saving" }
  | { kind: "conflict"; source: string }
  | { kind: "error"; message: string };

export class Autosave {
  private base: string;
  private draft: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<boolean> | undefined;
  private generation = 0;
  state: SaveState = { kind: "saved" };

  constructor(
    source: string,
    private readonly write: (expected: string, source: string) => Promise<SaveResult>,
    private readonly notify: (state: SaveState) => void,
  ) {
    this.base = this.draft = source;
  }

  get source(): string {
    return this.draft;
  }

  get revision(): number {
    return this.generation;
  }

  get unsaved(): boolean {
    return this.draft !== this.base || this.state.kind === "conflict" || this.state.kind === "error";
  }

  private update(state: SaveState) {
    this.state = state;
    this.notify(state);
  }

  change(source: string): void {
    ++this.generation;
    this.draft = source;
    clearTimeout(this.timer);
    if (this.state.kind === "conflict" || this.state.kind === "error") return;
    this.update({ kind: this.draft === this.base ? "saved" : "dirty" });
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.state.kind === "conflict" || this.state.kind === "error") return false;
    this.pending = this.save();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async save(): Promise<boolean> {
    while (this.draft !== this.base) {
      const source = this.draft;
      this.update({ kind: "saving" });
      let result: SaveResult;
      try {
        result = await this.write(this.base, source);
      } catch (error) {
        this.update({ kind: "error", message: String(error) });
        return false;
      }
      if (result.kind === "conflict") {
        this.update(result);
        return false;
      }
      this.base = source;
      ++this.generation;
    }
    this.update({ kind: "saved" });
    return true;
  }

  async retry(): Promise<boolean> {
    this.update({ kind: "dirty" });
    return this.flush();
  }

  async overwrite(): Promise<boolean> {
    if (this.state.kind !== "conflict") return false;
    this.base = this.state.source;
    ++this.generation;
    return this.retry();
  }

  async reconcile(source: string, revision = this.revision): Promise<boolean> {
    if (this.pending) await this.pending;
    if (revision !== this.revision) return false;
    if (source === this.base) return false;
    if (this.unsaved) {
      clearTimeout(this.timer);
      this.update({ kind: "conflict", source });
      return false;
    }
    this.base = this.draft = source;
    ++this.generation;
    this.update({ kind: "saved" });
    return true;
  }

  discard(source: string): void {
    ++this.generation;
    clearTimeout(this.timer);
    this.base = this.draft = source;
    this.update({ kind: "saved" });
  }

  fail(message: string): void {
    clearTimeout(this.timer);
    this.update({ kind: "error", message });
  }
}
