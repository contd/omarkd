//! Native Markdown-to-HTML rendering and syntax-highlighting styles.
//!
//! Comrak parses the document; Syntect highlights fenced code with reusable CSS
//! classes. Math and Mermaid are emitted as markers for lazy frontend renderers.
//! Image paths use Tauri's asset protocol. Generated HTML is intentionally not
//! sanitized here: the frontend must sanitize it before inserting it into the DOM.

// HashMap selects custom fenced-code renderers by language name.
use std::collections::HashMap;
// fmt::Write allows escaping into String buffers and Comrak output sinks alike.
use std::fmt::{self, Write};
use std::path::{Path, PathBuf};
// Arc lets Comrak share URL rewriters; LazyLock caches expensive syntax loading.
use std::sync::{Arc, LazyLock};

// Adapter traits are Comrak's extension points for fences and image URLs.
use comrak::adapters::CodefenceRendererAdapter;
use comrak::nodes::Sourcepos;
use comrak::options::{Extension, Plugins, Render, URLRewriter};
use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};
use comrak::{markdown_to_html_with_plugins, Options};
use syntect::highlighting::ThemeSet;
use syntect::html::{css_for_theme_with_class_style, ClassStyle};

/// Shared prefix for HTML token classes and the generated Syntect stylesheet.
const CLASS_PREFIX: &str = "sx-";

/// Loading syntect's syntax definitions is the most expensive part of a cold
/// render, so it is done once and can be pre-warmed on a background thread.
static HIGHLIGHTER: LazyLock<SyntectAdapter> = LazyLock::new(|| {
    SyntectAdapterBuilder::new()
        // Emit token classes rather than inline colors so themes can switch via CSS.
        .css_with_class_prefix(CLASS_PREFIX)
        // two-face adds languages beyond Syntect's basic syntax collection.
        .syntax_set(two_face::syntax::extra_newlines())
        .build()
});

/// Initializes the cached highlighter and exercises a small Markdown/code render.
///
/// Startup calls this on a background thread to overlap cold initialization with
/// webview creation; subsequent calls reuse the same syntax definitions.
pub fn warm_up() {
    LazyLock::force(&HIGHLIGHTER);
    let _ = render_markdown("# warm\n```rust\nfn main() {}\n```\n", None);
}

/// Mermaid blocks are emitted untouched so the frontend can lazily render them.
///
/// This zero-sized adapter has no mutable state and is shared by all renders.
struct MermaidRenderer;

/// Implements Comrak's fenced-code hook for fences identified as `mermaid`.
impl CodefenceRendererAdapter for MermaidRenderer {
    /// Wraps escaped Mermaid source in a recognizable `<pre class="mermaid">`.
    ///
    /// Language, metadata and source positions are unused because this adapter is
    /// registered only for Mermaid. Returns a formatting error if the sink fails.
    fn write(
        &self,
        output: &mut dyn Write,
        _lang: &str,
        _meta: &str,
        code: &str,
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        // Escape diagram text rather than allowing it to become active HTML.
        output.write_str("<pre class=\"mermaid\">")?;
        escape_into(output, code)?;
        output.write_str("</pre>\n")
    }
}

/// Shared stateless Mermaid adapter installed in each document's plugin registry.
static MERMAID: MermaidRenderer = MermaidRenderer;

/// Writes text with HTML-significant characters escaped into a formatting sink.
///
/// Iterating over Unicode characters preserves non-ASCII diagram text. `?`
/// propagates a failing sink instead of continuing with incomplete output.
fn escape_into(output: &mut dyn Write, text: &str) -> fmt::Result {
    for c in text.chars() {
        match c {
            '&' => output.write_str("&amp;")?,
            '<' => output.write_str("&lt;")?,
            '>' => output.write_str("&gt;")?,
            '"' => output.write_str("&quot;")?,
            _ => output.write_char(c)?,
        }
    }
    Ok(())
}

/// Rewrites relative image URLs so they resolve against the document's
/// directory through Tauri's asset protocol.
struct ImageRewriter {
    /// Owned document directory, kept alive while Comrak invokes the rewriter.
    base_dir: PathBuf,
}

/// Applies document-relative asset resolution only to Markdown image URLs.
impl URLRewriter for ImageRewriter {
    /// Leaves remote, fragment-only and protocol-relative URLs unchanged.
    ///
    /// Other URLs are percent-decoded into a filesystem path, joined to the
    /// document directory when relative, and re-encoded for Tauri's asset handler.
    fn to_html(&self, url: &str) -> String {
        if url.is_empty() || has_scheme(url) || url.starts_with('#') || url.starts_with("//") {
            return url.to_string();
        }
        let decoded = percent_decode(url);
        let path = Path::new(&decoded);
        let full = if path.is_absolute() {
            // Absolute image paths do not inherit the document directory.
            path.to_path_buf()
        } else {
            self.base_dir.join(path)
        };
        asset_url(&full.to_string_lossy())
    }
}

/// Recognizes a multi-character scheme-like prefix before the first colon.
///
/// A one-letter prefix is treated as a Windows drive, not an external scheme.
/// This is a routing heuristic, not a complete URL parser or security policy.
fn has_scheme(url: &str) -> bool {
    match url.find(':') {
        // Single-letter "schemes" are Windows drive letters.
        Some(i) if i > 1 => url[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')),
        _ => false,
    }
}

/// Decodes valid `%HH` byte escapes while leaving malformed escapes intact.
///
/// UTF-8 decoding is lossy for invalid byte sequences because image-path display
/// should not fail the entire Markdown render. Plus signs are not converted to spaces.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Only attempt hex decoding when two bytes follow the percent sign.
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                // A decoded escape consumed three input bytes.
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        // Invalid escapes and ordinary bytes advance by one instead.
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encodes UTF-8 bytes except RFC 3986 unreserved characters.
///
/// Slashes, query separators and fragment markers are encoded too, so a complete
/// file path can safely occupy a query value or Tauri asset URL path component.
pub fn percent_encode(s: &str) -> String {
    // Three output characters per byte is the worst-case encoded size.
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            // Uppercase, two-digit hex makes every escaped byte unambiguous.
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Mirrors `convertFileSrc` from `@tauri-apps/api/core`.
///
/// Windows and Android use an HTTP-style custom-protocol host; other targets use
/// `asset://localhost`. This constructs a URL, not a grant of filesystem access.
fn asset_url(path: &str) -> String {
    let encoded = percent_encode(path);
    if cfg!(any(windows, target_os = "android")) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

/// Builds consistent Comrak parsing/rendering options for each document.
///
/// An optional directory enables image rewriting; no directory is needed for
/// isolated parser tests or the startup warm-up. Unlisted options retain defaults.
fn options(base_dir: Option<&Path>) -> Options<'static> {
    let extension = Extension {
        // GitHub-style text, tables, automatic links and checkbox lists.
        strikethrough: true,
        table: true,
        autolink: true,
        tasklist: true,
        // Additional inline notation and reference/definition structures.
        superscript: true,
        subscript: false,
        footnotes: true,
        description_lists: true,
        // Consume leading YAML front matter without showing it in the document.
        front_matter_delimiter: Some("---".to_string()),
        // Recognize callouts, multiline quotations, math markers and emoji shortcodes.
        multiline_block_quotes: true,
        alerts: true,
        math_dollars: true,
        math_code: true,
        shortcodes: true,
        underline: false,
        spoiler: false,
        // An empty prefix still enables stable heading IDs for outline links.
        header_id_prefix: Some(String::new()),
        wikilinks_title_after_pipe: true,
        image_url_rewriter: base_dir.map(|d| {
            // Own the directory so the options do not borrow caller-owned storage.
            Arc::new(ImageRewriter {
                base_dir: d.to_path_buf(),
            }) as Arc<dyn URLRewriter>
        }),
        ..Default::default()
    };
    let render = Render {
        // Preserve supported raw HTML; the frontend sanitizes before DOM insertion.
        r#unsafe: true,
        // Use standard language-marked code and styled task-list markup.
        github_pre_lang: false,
        tasklist_classes: true,
        ..Default::default()
    };
    Options {
        extension,
        render,
        ..Default::default()
    }
}

/// Renders Markdown with cached syntax highlighting and a Mermaid fence adapter.
///
/// `base_dir` is the source document's directory for local Markdown images.
/// The returned HTML can contain raw embedded HTML and must pass through the
/// frontend sanitizer before use. Math/diagrams are completed by frontend code.
pub fn render_markdown(source: &str, base_dir: Option<&Path>) -> String {
    let options = options(base_dir);
    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&*HIGHLIGHTER);
    // Registering Mermaid separately keeps its source out of ordinary highlighting.
    let mut renderers: HashMap<String, &dyn CodefenceRendererAdapter> = HashMap::new();
    renderers.insert("mermaid".to_string(), &MERMAID);
    plugins.render.codefence_renderers = renderers;
    markdown_to_html_with_plugins(source, &options, &plugins)
}

/// CSS for the class-based highlighter, with a light and a dark theme.
///
/// The stylesheet contains both palettes, scoped to the root `data-theme` value,
/// and uses the same [`CLASS_PREFIX`] as rendered token classes.
///
/// # Panics
///
/// Panics if the bundled Syntect theme set cannot produce its expected themes.
pub fn highlight_css() -> String {
    let themes = ThemeSet::load_defaults();
    let style = ClassStyle::SpacedPrefixed {
        prefix: CLASS_PREFIX,
    };
    // These names refer to bundled themes, not files or user configuration.
    let light = css_for_theme_with_class_style(&themes.themes["InspiredGitHub"], style)
        .expect("valid built-in light syntax theme");
    let dark = css_for_theme_with_class_style(&themes.themes["base16-ocean.dark"], style)
        .expect("valid built-in dark syntax theme");
    format!(
        "{}\n{}",
        scope_highlight_css(&light, "light"),
        scope_highlight_css(&dark, "dark")
    )
}

/// Adds a zero-specificity root-theme guard to every generated selector.
///
/// Syntect's selector lists occupy one line and start with a class selector.
/// This helper depends on that generated format; it is not a general CSS parser.
/// `:where(...)` avoids changing selector specificity and needs no CSS nesting.
fn scope_highlight_css(css: &str, theme: &str) -> String {
    let prefix = format!(":where(:root[data-theme=\"{theme}\"])");
    // Syntect emits each selector list on one line; scope every list member
    // without CSS nesting or increasing the highlighter's specificity.
    css.lines()
        .map(|line| {
            if line.starts_with('.') {
                // Guard each comma-separated selector, not just the first one.
                format!("{prefix} {}", line.replace(", ", &format!(", {prefix} ")))
            } else {
                // Declarations, braces and other non-selector lines stay unchanged.
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parser, URL and stylesheet regression tests stored outside production code.
#[cfg(test)]
#[path = "../../tests/render.rs"]
mod tests;
