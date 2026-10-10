const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export const isMarkdownPath = (path: string) => MARKDOWN_EXT.test(path);

/** True for URLs that should be handed to the system browser / handler. */
export const isExternalUrl = (href: string) => SCHEME.test(href) && !href.toLowerCase().startsWith("file:");

const isAbsolute = (p: string) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);

/** Resolves `target` (relative or absolute, URL-encoded) against `baseDir`. */
export function resolvePath(baseDir: string, target: string): string {
  let t = target;
  if (t.toLowerCase().startsWith("file://")) t = t.slice(7);
  try {
    t = decodeURIComponent(t);
  } catch {
    // keep undecoded text
  }
  const joined = isAbsolute(t) ? t : `${baseDir.replace(/[\\/]+$/, "")}/${t}`;
  const drive = joined.match(/^[a-zA-Z]:/)?.[0] ?? "";
  const parts: string[] = [];
  for (const seg of joined.slice(drive.length).split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `${drive}/${parts.join("/")}`;
}

/** Splits `path#fragment`, ignoring a `?query`. */
export function splitHref(href: string): [string, string] {
  const hash = href.indexOf("#");
  const path = hash >= 0 ? href.slice(0, hash) : href;
  const frag = hash >= 0 ? href.slice(hash + 1) : "";
  return [path.split("?")[0], frag];
}
