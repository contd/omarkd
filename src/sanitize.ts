// Markdown files may embed raw HTML. Rendering happens in a <template>, so nothing
// executes before this pass strips anything active. The CSP is a second layer.
const BLOCKED = "script,iframe,frame,frameset,object,embed,applet,base,meta,link,form,noscript,portal";
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "background", "srcset"]);
const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

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
