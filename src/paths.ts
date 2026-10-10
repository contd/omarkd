/**
 * Filesystem-path and Markdown-link routing helpers shared by reader navigation.
 * @packageDocumentation
 */
/** Markdown extensions supported by the frontend, including MDX treated as text. */
const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
/** Multi-character URI scheme heuristic, excluding single-letter Windows drives. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/** Tests a document path for a recognized Markdown extension, case-insensitively. */
export const isMarkdownPath = (path: string) => MARKDOWN_EXT.test(path);

/** True for URLs that should be handed to the system browser / handler. */
export const isExternalUrl = (href: string) => SCHEME.test(href) && !href.toLowerCase().startsWith("file:");

/** Recognizes POSIX roots and Windows drive-prefixed absolute paths. */
const isAbsolute = (p: string) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);

/**
 * Resolves a relative/absolute, URL-encoded target against a document directory.
 * Strips a file URL prefix, normalizes separators and dot segments, and retains
 * undecodable text. This is lexical resolution, not filesystem canonicalization.
 * @param baseDir - Parent directory of the current Markdown document.
 * @param target - Link path without query or fragment.
 */
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

/** Splits a link into `[path, fragment]`, stripping query text from the path. */
export function splitHref(href: string): [string, string] {
  const hash = href.indexOf("#");
  const path = hash >= 0 ? href.slice(0, hash) : href;
  const frag = hash >= 0 ? href.slice(hash + 1) : "";
  return [path.split("?")[0], frag];
}
