import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test as base } from "@playwright/test";

/** Generated native fixture response with source included for editor conflict checks. */
export interface RenderedDocument {
  /** Virtual absolute document path used by real frontend path resolution. */
  path: string;
  /** Virtual directory shared by fixture-local links and image references. */
  dir: string;
  /** Fixture filename used for native title calls. */
  title: string;
  /** Real Rust-rendered HTML, not a JavaScript parser approximation. */
  html: string;
  /** Deterministic display timing, not a performance benchmark. */
  renderMs: number;
  /** Current emulated disk text, mutable to simulate outside writes. */
  source: string;
}

/** Data loaded once by fixture setup and copied into every new browser context. */
interface BridgeData {
  /** Document responses keyed by virtual path. */
  documents: Record<string, RenderedDocument>;
  /** Real Syntect palette CSS emitted by the fixture builder. */
  highlightCss: string;
}

/** Scenario controls and captured native calls exposed as window.omarkdTest. */
export interface Bridge {
  /** Ordered command/argument history for verifying exact native API wiring. */
  calls: { command: string; args: Record<string, unknown> }[];
  /** Emulated disk state unique to this page's initialization. */
  documents: Record<string, RenderedDocument>;
  /** Next open-dialog result; null models user cancellation. */
  dialogResult: string | string[] | null;
  /** Optional watcher-subscription failure shown by the reader UI. */
  watchError: string | null;
  /** Per-path render delay used to force stale-load races. */
  delays: Record<string, number>;
  /** Render completions, separate from request order, used for race assertions. */
  completedRenders: string[];
  /** Optional simulated write error, preserving local draft behavior. */
  saveError: string | null;
  /** Delay for each native save acknowledgment, allowing newer edits during a write. */
  saveDelay: number;
  /** Delivers a native-shaped event; throws when no subscription was installed. */
  emit: (event: string, payload: unknown) => void;
}

declare global {
  /** Browser-only additions required by the bridge and scenario drivers. */
  interface Window {
    /** Exposed Node-side binding renders edited Markdown through real Rust. */
    renderTestMarkdown: (source: string) => Promise<string>;
    /** Test controls, never added to the desktop production application. */
    omarkdTest: Bridge;
    /** Minimal protocol used by Tauri's JavaScript API in the browser. */
    __TAURI_INTERNALS__: {
      /** Virtual document-window identity expected by getCurrentWebviewWindow. */
      metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
      /** Routes native commands into strict, recorded emulations. */
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      /** Registers a callback ID matching Tauri's event subscription convention. */
      transformCallback: (callback: (event: unknown) => void) => number;
      /** Releases a stored callback from the registry. */
      unregisterCallback: (id: number) => void;
    };
    /** Removes event handlers when Tauri's JavaScript listener is disposed. */
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => void };
  }
}

/** Shared Playwright fixture: inject native seam, run scenario and reject browser exceptions. */
export const test = base.extend<{ bridge: void }>({
  bridge: [async ({ page, context }, use) => {
    // Use one temporary file per edit render; concurrent browser workers cannot collide.
    await context.exposeBinding("renderTestMarkdown", (_source, source: string) => {
      const dir = mkdtempSync(resolve(tmpdir(), "omarkd-render-"));
      try {
        const file = resolve(dir, "source.md");
        writeFileSync(file, source);
        return execFileSync(resolve("src-tauri/target/debug/examples/render-fixtures"), [file], { encoding: "utf8" });
      } finally {
        // Cleanup is restricted to the newly allocated rendering directory.
        rmSync(dir, { recursive: true });
      }
    });
    const data: BridgeData = JSON.parse(readFileSync(resolve("e2e/.generated/documents.json"), "utf8"));
    await context.addInitScript((data: BridgeData) => {
      // Initialization executes in the page, so helpers must be self-contained here.
      let nextId = 0;
      // Callback IDs preserve the same call/event shape used by Tauri's JS packages.
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners = new Map<string, number[]>();
      const bridge: Bridge = {
        calls: [],
        documents: data.documents,
        dialogResult: null,
        watchError: null,
        delays: {},
        completedRenders: [],
        saveError: null,
        saveDelay: 0,
        /** Deliver each recorded subscription using the expected event/id/payload envelope. */
        emit(event, payload) {
          const handlers = listeners.get(event);
          if (!handlers?.length) throw new Error(`No listener registered for ${event}`);
          for (const handler of handlers) callbacks.get(handler)!({ event, id: handler, payload });
        },
      };
      window.omarkdTest = bridge;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "doc-test" }, currentWebview: { label: "doc-test" } },
        /** Allocate IDs shared by callbacks and subscription acknowledgments. */
        transformCallback(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
        /** Remove callbacks that the frontend has disposed. */
        unregisterCallback(id) { callbacks.delete(id); },
        /** Record and execute only supported native calls; new APIs require explicit bridge wiring. */
        async invoke(command, args = {}) {
          bridge.calls.push({ command, args });
          switch (command) {
            case "highlight_css": return data.highlightCss;
            case "read_source": {
              const doc = bridge.documents[String(args.path)];
              if (!doc) throw new Error("Missing source document");
              return doc.source;
            }
            case "save_source": {
              // Match the frontend's expected-content protocol; native Rust tests cover actual writes.
              if (bridge.saveDelay) await new Promise(resolve => setTimeout(resolve, bridge.saveDelay));
              if (bridge.saveError) throw new Error(bridge.saveError);
              const doc = bridge.documents[String(args.path)];
              if (doc.source !== args.expected) return { kind: "conflict", source: doc.source };
              doc.source = String(args.source);
              doc.html = await window.renderTestMarkdown(doc.source);
              return { kind: "saved" };
            }
            case "render_file": {
              const path = String(args.path);
              const doc = bridge.documents[path];
              if (!doc) throw new Error(`Could not read ${path}: No such file or directory`);
              if (bridge.delays[path]) await new Promise(resolve => setTimeout(resolve, bridge.delays[path]));
              bridge.completedRenders.push(path);
              // Translate only this fixture's native asset URL at the browser boundary.
              return { ...doc, html: doc.html.replace(/(?:asset:\/\/localhost|http:\/\/asset.localhost)\/%2Fdocuments%2Fimage.svg/g, "/e2e/fixtures/image.svg") };
            }
            case "watch_file":
              // Real OS watcher delivery is replaced by explicit scenario emit calls.
              if (bridge.watchError) throw new Error(bridge.watchError);
              return null;
            case "plugin:dialog|open": return bridge.dialogResult;
            case "plugin:event|listen": {
              // Store the handler registered by the real @tauri-apps/api listener.
              const event = String(args.event);
              listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
              return ++nextId;
            }
            case "plugin:event|unlisten": return null;
            case "open_in_new_window":
            // Window/opener calls are recorded, never executed against the desktop OS.
            case "plugin:window|set_theme":
            case "plugin:window|set_title":
            case "plugin:window|show":
            case "plugin:window|set_focus":
            case "plugin:window|destroy":
            case "finish_quit":
              if (args.saved === false) bridge.emit("omarkd://quit-cancelled", args.request);
              return undefined;
            case "plugin:opener|open_url":
            case "plugin:opener|open_path":
            case "plugin:opener|reveal_item_in_dir":
              return null;
            default: throw new Error(`Unimplemented Tauri test command: ${command}`);
          }
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        /** Filter a disposed handler without removing other subscriptions to that event. */
        unregisterListener(event, id) {
          listeners.set(event, (listeners.get(event) ?? []).filter(handler => handler !== id));
        },
      };
    }, data);
    const errors: string[] = [];
    // Report uncaught frontend exceptions even if a later visual assertion passes.
    page.on("pageerror", error => errors.push(error.message));
    await use();
    expect(errors, "Unexpected browser exceptions").toEqual([]);
  }, { auto: true }],
});

export { expect } from "@playwright/test";
/**
 * Strict browser-only Tauri bridge installed before the frontend module loads.
 *
 * Initial documents come from Cargo's production parser/highlighter; edits invoke
 * that same native renderer through an exposed binding. Only desktop APIs are
 * emulated. Unknown commands and unexpected page exceptions fail the test.
 * This does not verify real Finder, dialog, watcher or native window integrations.
 * @packageDocumentation
 */
