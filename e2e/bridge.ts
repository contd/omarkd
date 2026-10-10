import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test as base } from "@playwright/test";

export interface RenderedDocument {
  path: string;
  dir: string;
  title: string;
  html: string;
  renderMs: number;
  source: string;
}

interface BridgeData {
  documents: Record<string, RenderedDocument>;
  highlightCss: string;
}

export interface Bridge {
  calls: { command: string; args: Record<string, unknown> }[];
  documents: Record<string, RenderedDocument>;
  dialogResult: string | string[] | null;
  watchError: string | null;
  delays: Record<string, number>;
  completedRenders: string[];
  saveError: string | null;
  saveDelay: number;
  emit: (event: string, payload: unknown) => void;
}

declare global {
  interface Window {
    renderTestMarkdown: (source: string) => Promise<string>;
    omarkdTest: Bridge;
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      transformCallback: (callback: (event: unknown) => void) => number;
      unregisterCallback: (id: number) => void;
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => void };
  }
}

export const test = base.extend<{ bridge: void }>({
  bridge: [async ({ page, context }, use) => {
    await context.exposeBinding("renderTestMarkdown", (_source, source: string) => {
      const dir = mkdtempSync(resolve(tmpdir(), "omarkd-render-"));
      try {
        const file = resolve(dir, "source.md");
        writeFileSync(file, source);
        return execFileSync(resolve("src-tauri/target/debug/examples/render-fixtures"), [file], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
    const data: BridgeData = JSON.parse(readFileSync(resolve("e2e/.generated/documents.json"), "utf8"));
    await context.addInitScript((data: BridgeData) => {
      let nextId = 0;
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
        emit(event, payload) {
          const handlers = listeners.get(event);
          if (!handlers?.length) throw new Error(`No listener registered for ${event}`);
          for (const handler of handlers) callbacks.get(handler)!({ event, id: handler, payload });
        },
      };
      window.omarkdTest = bridge;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "doc-test" }, currentWebview: { label: "doc-test" } },
        transformCallback(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
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
              if (bridge.watchError) throw new Error(bridge.watchError);
              return null;
            case "plugin:dialog|open": return bridge.dialogResult;
            case "plugin:event|listen": {
              const event = String(args.event);
              listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
              return ++nextId;
            }
            case "plugin:event|unlisten": return null;
            case "open_in_new_window":
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
        unregisterListener(event, id) {
          listeners.set(event, (listeners.get(event) ?? []).filter(handler => handler !== id));
        },
      };
    }, data);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await use();
    expect(errors, "Unexpected browser exceptions").toEqual([]);
  }, { auto: true }],
});

export { expect } from "@playwright/test";
