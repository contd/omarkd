/**
 * Lightweight CodeMirror Markdown editor, lazily imported on entering edit mode.
 * @packageDocumentation
 */
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

/**
 * Mounts and focuses a line-numbered, wrapped Markdown text editor.
 * Internally uses LF; outgoing changes restore the source's BOM and LF/CRLF
 * convention. Replacing text updates that convention without notifying autosave.
 * @param host - Parent DOM container.
 * @param source - Initial source text, optionally including a UTF-8 BOM.
 * @param dark - Initial syntax palette.
 * @param onChange - Receives full source after user-originated document changes.
 * @returns Controls whose destroy method must be called when leaving edit mode.
 */
export function createTextEditor(host: HTMLElement, source: string, dark: boolean, onChange: (source: string) => void) {
  const theme = new Compartment();
  let bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  let separator = source.includes("\r\n") ? "\r\n" : "\n";
  let replacing = false;
  const colors = (dark: boolean) => syntaxHighlighting(HighlightStyle.define([
    { tag: tags.heading, color: dark ? "#79c0ff" : "#0550ae", fontWeight: "bold" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: [tags.link, tags.url], color: dark ? "#a5d6ff" : "#0969da" },
    { tag: [tags.monospace, tags.string], color: dark ? "#a5d6ff" : "#0a3069" },
    { tag: tags.processingInstruction, color: dark ? "#ff7b72" : "#cf222e" },
  ]));
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: source.slice(bom.length).replace(/\r\n?/g, "\n"),
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
        history(), markdown(), search(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Markdown editor", spellcheck: "false" }),
        theme.of(colors(dark)),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !replacing) onChange(bom + view.state.doc.toString().replace(/\n/g, separator));
        }),
      ],
    }),
  });
  view.focus();
  return {
    /** Returns keyboard focus to the text editor. */
    focus: () => view.focus(),
    /** Reconfigures syntax colors without disturbing document text or undo history. */
    setTheme: (dark: boolean) => view.dispatch({ effects: theme.reconfigure(colors(dark)) }),
    /** Replaces source from disk, suppressing onChange to avoid an autosave feedback loop. */
    replace(source: string) {
      replacing = true;
      try {
        bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
        separator = source.includes("\r\n") ? "\r\n" : "\n";
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source.slice(bom.length).replace(/\r\n?/g, "\n") } });
      } finally {
        replacing = false;
      }
    },
    /** Opens the editor's built-in search panel. */
    find: () => openSearchPanel(view),
    /** Closes the editor's built-in search panel. */
    closeFind: () => closeSearchPanel(view),
    /** Releases CodeMirror's DOM and event resources. */
    destroy: () => view.destroy(),
  };
}

/** Lifecycle/search/theme controls returned by {@link createTextEditor}. */
export type TextEditor = ReturnType<typeof createTextEditor>;
