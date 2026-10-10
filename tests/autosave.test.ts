/**
 * Autosave state-machine tests with deterministic fake time and controllable writes.
 * Native I/O is replaced at the writer callback; Rust tests cover actual file saves.
 * Assertions protect debounce boundaries, draft retention and stale-read rejection.
 * @packageDocumentation
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosave, type SaveResult } from "../src/autosave";

// No wall-clock sleeps: advancing 299/300 ms verifies the exact debounce contract.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("autosave queue", () => {
  /** Two edits within one debounce window produce exactly one write of the latest text. */
  it("debounces changes and saves the latest draft", async () => {
    const write = vi.fn().mockResolvedValue({ kind: "saved" });
    const notify = vi.fn();
    const save = new Autosave("original", write, notify);
    save.change("first");
    save.change("latest");
    expect(save.source).toBe("latest");
    expect(save.unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledExactlyOnceWith("original", "latest");
    expect(save.unsaved).toBe(false);
    expect(notify).toHaveBeenLastCalledWith({ kind: "saved" });
    expect(await save.flush()).toBe(true);
  });

  /** Hold the first write open; concurrent flush callers must share the queue and save the newer draft. */
  it("serializes in-flight changes and drains every newer draft before leaving", async () => {
    let finish!: (result: SaveResult) => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ kind: "saved" });
    const save = new Autosave("original", write, vi.fn());
    save.change("first");
    const first = save.flush();
    save.change("second");
    const second = save.flush();
    expect(write).toHaveBeenCalledTimes(1);
    finish({ kind: "saved" });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(write.mock.calls).toEqual([["original", "first"], ["first", "second"]]);
    expect(save.unsaved).toBe(false);
  });

  /** Repeated external changes require repeated decisions, never an unchecked force overwrite. */
  it("pauses on conflict, preserves later edits, and rechecks an explicit overwrite", async () => {
    const write = vi.fn().mockResolvedValueOnce({ kind: "conflict", source: "external" })
      .mockResolvedValueOnce({ kind: "conflict", source: "external-new" })
      .mockResolvedValue({ kind: "saved" });
    const save = new Autosave("original", write, vi.fn());
    expect(await save.overwrite()).toBe(false);
    save.change("mine");
    expect(await save.flush()).toBe(false);
    save.change("my-new-edits");
    expect(await save.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await save.overwrite()).toBe(false);
    expect(await save.overwrite()).toBe(true);
    expect(write.mock.calls[2]).toEqual(["external-new", "my-new-edits"]);
  });

  /** Simulate permission failure; retry resumes explicitly and discard cancels its pending timer. */
  it("surfaces errors, pauses automatic retries, and supports retry and discard", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("read only")).mockResolvedValue({ kind: "saved" });
    const save = new Autosave("original", write, vi.fn());
    save.change("mine");
    expect(await save.flush()).toBe(false);
    expect(save.state).toMatchObject({ kind: "error", message: "Error: read only" });
    save.change("mine-new");
    expect(await save.flush()).toBe(false);
    expect(await save.retry()).toBe(true);
    save.change("discard me");
    save.discard("disk");
    expect(save.source).toBe("disk");
    expect(save.unsaved).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(write).toHaveBeenCalledTimes(2);
    save.fail("read error");
    expect(save.unsaved).toBe(true);
    expect(save.state).toEqual({ kind: "error", message: "read error" });
  });

  /** Disk updates can replace clean text, but dirty drafts become conflicts and stay local. */
  it("reconciles external edits only when the draft is clean", async () => {
    const save = new Autosave("original", vi.fn().mockResolvedValue({ kind: "saved" }), vi.fn());
    expect(await save.reconcile("original")).toBe(false);
    expect(await save.reconcile("external")).toBe(true);
    expect(save.source).toBe("external");
    save.change("mine");
    expect(await save.reconcile("new disk")).toBe(false);
    expect(save.state).toEqual({ kind: "conflict", source: "new disk" });
    expect(save.source).toBe("mine");
  });

  /** A watcher snapshot from our own in-flight save must not be applied as a new external document. */
  it("waits for a pending save before reconciling its watcher event", async () => {
    let finish!: (result: SaveResult) => void;
    const save = new Autosave("original", () => new Promise(resolve => { finish = resolve; }), vi.fn());
    save.change("mine");
    const flushing = save.flush();
    const reconciling = save.reconcile("mine");
    finish({ kind: "saved" });
    expect(await flushing).toBe(true);
    expect(await reconciling).toBe(false);
    expect(save.unsaved).toBe(false);
  });

  /** Undo back to the acknowledged base is a no-op, not another disk write. */
  it("does not write unchanged text and handles undoing changes", async () => {
    const write = vi.fn();
    const save = new Autosave("original", write, vi.fn());
    save.change("changed");
    save.change("original");
    expect(await save.flush()).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  /** Revision tokens make delayed reads harmless both before and after a newer draft is saved. */
  it("does not apply disk snapshots taken before a newer edit or save", async () => {
    const save = new Autosave("original", vi.fn().mockResolvedValue({ kind: "saved" }), vi.fn());
    const revision = save.revision;
    save.change("newer draft");
    expect(await save.reconcile("old snapshot", revision)).toBe(false);
    expect(save.source).toBe("newer draft");
    expect(await save.flush()).toBe(true);
    expect(await save.reconcile("original", revision)).toBe(false);
    expect(save.source).toBe("newer draft");
    expect(save.unsaved).toBe(false);
  });
});
