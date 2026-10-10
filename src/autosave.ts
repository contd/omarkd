/**
 * Serial, debounced saving with explicit conflict/error recovery.
 * Native writes compare full source snapshots; this module retains local drafts.
 * @packageDocumentation
 */

/** Native save acknowledgment, or current disk contents when an external edit conflicts. */
export type SaveResult = { kind: "saved" } | { kind: "conflict"; source: string };
/** UI-facing save status. Conflict/error states pause automatic writes. */
export type SaveState =
  | { kind: "saved" | "dirty" | "saving" }
  | { kind: "conflict"; source: string }
  | { kind: "error"; message: string };

/**
 * Owns one document's last acknowledged source and latest local draft.
 * Writes are serialized and drain newer edits before a successful flush completes.
 */
export class Autosave {
  /** Last source acknowledged by a successful read/save or explicit resolution. */
  private base: string;
  /** Latest local text, retained even when a write fails or conflicts. */
  private draft: string;
  /** Pending 300 ms debounce; cancelled by explicit flush and paused states. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Shared completion promise while a serialized write loop is running. */
  private pending: Promise<boolean> | undefined;
  /** Revision counter used to reject stale external-source reads. */
  private generation = 0;
  /** Latest status presented to the caller's notification callback. */
  state: SaveState = { kind: "saved" };

  /**
   * Creates a clean session.
   * @param source - Initial disk snapshot.
   * @param write - Conflict-aware writer receiving expected and desired source.
   * @param notify - Called synchronously whenever the displayed state changes.
   */
  constructor(
    source: string,
    private readonly write: (expected: string, source: string) => Promise<SaveResult>,
    private readonly notify: (state: SaveState) => void,
  ) {
    this.base = this.draft = source;
  }

  /** Current draft, including unsaved changes, suitable for copying to the clipboard. */
  get source(): string {
    return this.draft;
  }

  /** Token captured before an asynchronous disk read to detect intervening changes. */
  get revision(): number {
    return this.generation;
  }

  /** Whether local changes or unresolved save/read failures require preserving the session. */
  get unsaved(): boolean {
    return this.draft !== this.base || this.state.kind === "conflict" || this.state.kind === "error";
  }

  /** Sets the status and notifies the owner without altering source text. */
  private update(state: SaveState) {
    this.state = state;
    this.notify(state);
  }

  /** Replaces the draft and restarts debounce unless conflict/error recovery is required. */
  change(source: string): void {
    ++this.generation;
    this.draft = source;
    clearTimeout(this.timer);
    if (this.state.kind === "conflict" || this.state.kind === "error") return;
    this.update({ kind: this.draft === this.base ? "saved" : "dirty" });
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  /**
   * Cancels debounce and drains pending writes, sharing any in-flight save.
   * @returns Whether all drafts were saved; false means a paused error or conflict.
   */
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

  /** Writes successive draft snapshots; only acknowledged writes advance the disk base. */
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

  /** Explicitly resumes saving after a failure, still comparing the expected disk source. */
  async retry(): Promise<boolean> {
    this.update({ kind: "dirty" });
    return this.flush();
  }

  /**
   * Uses the reported conflict source as the new expected snapshot and retries.
   * This is not a blind overwrite: another external edit can cause another conflict.
   */
  async overwrite(): Promise<boolean> {
    if (this.state.kind !== "conflict") return false;
    this.base = this.state.source;
    ++this.generation;
    return this.retry();
  }

  /**
   * Reconciles an external disk snapshot after any pending save finishes.
   * @param source - Fresh disk text.
   * @param revision - Session revision captured before reading that text.
   * @returns True only when a clean editor should replace its text with this snapshot.
   */
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

  /** Explicitly abandons the draft and accepts a new clean disk snapshot. */
  discard(source: string): void {
    ++this.generation;
    clearTimeout(this.timer);
    this.base = this.draft = source;
    this.update({ kind: "saved" });
  }

  /** Pauses writes after a source-read failure without discarding local text. */
  fail(message: string): void {
    clearTimeout(this.timer);
    this.update({ kind: "error", message });
  }
}
