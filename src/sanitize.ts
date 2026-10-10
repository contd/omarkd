/**
 * Inert parsing and filtering of HTML returned by the native Markdown renderer.
 * CSP supplies a separate defense; this filter is not a general-purpose sanitizer.
 * @packageDocumentation
 */
/** Active or document-level elements removed from embedded Markdown HTML. */
const BLOCKED = "script,iframe,frame,frameset,object,embed,applet,base,meta,link,form,noscript,portal";
/** Attributes whose values can contain navigation/resource URLs. */
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "background", "srcset"]);
/** Active URL prefixes rejected after stripping control characters. */
const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

/**
 * Parses into an inert template, removes blocked elements/event handlers and
 * dangerous URL values, then returns a fragment ready for reader insertion.
 * Does not rewrite local image paths; the Rust Markdown image rewriter does that.
 */
export function sanitize(html: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const root = tpl.content;
  root.querySelectorAll(BLOCKED).forEach((el) => el.remove());
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (URL_ATTRS.has(name) && DANGEROUS_URL.test(attr.value.replace(/[\u0000-\u001f]/g, "")))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return root;
}
