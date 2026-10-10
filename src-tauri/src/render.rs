use std::collections::HashMap;
use std::fmt::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use comrak::adapters::CodefenceRendererAdapter;
use comrak::nodes::Sourcepos;
use comrak::options::{Extension, Plugins, Render, URLRewriter};
use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};
use comrak::{markdown_to_html_with_plugins, Options};
use syntect::highlighting::ThemeSet;
use syntect::html::{css_for_theme_with_class_style, ClassStyle};

const CLASS_PREFIX: &str = "sx-";

/// Loading syntect's syntax definitions is the most expensive part of a cold
/// render, so it is done once and can be pre-warmed on a background thread.
static HIGHLIGHTER: LazyLock<SyntectAdapter> = LazyLock::new(|| {
    SyntectAdapterBuilder::new()
        .css_with_class_prefix(CLASS_PREFIX)
        .syntax_set(two_face::syntax::extra_newlines())
        .build()
});

pub fn warm_up() {
    LazyLock::force(&HIGHLIGHTER);
    let _ = render_markdown("# warm\n```rust\nfn main() {}\n```\n", None);
}

/// Mermaid blocks are emitted untouched so the frontend can lazily render them.
struct MermaidRenderer;

impl CodefenceRendererAdapter for MermaidRenderer {
    fn write(
        &self,
        output: &mut dyn Write,
        _lang: &str,
        _meta: &str,
        code: &str,
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        output.write_str("<pre class=\"mermaid\">")?;
        escape_into(output, code)?;
        output.write_str("</pre>\n")
    }
}

static MERMAID: MermaidRenderer = MermaidRenderer;

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
    base_dir: PathBuf,
}

impl URLRewriter for ImageRewriter {
    fn to_html(&self, url: &str) -> String {
        if url.is_empty() || has_scheme(url) || url.starts_with('#') || url.starts_with("//") {
            return url.to_string();
        }
        let decoded = percent_decode(url);
        let path = Path::new(&decoded);
        let full = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.base_dir.join(path)
        };
        asset_url(&full.to_string_lossy())
    }
}

fn has_scheme(url: &str) -> bool {
    match url.find(':') {
        // Single-letter "schemes" are Windows drive letters.
        Some(i) if i > 1 => url[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')),
        _ => false,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Mirrors `convertFileSrc` from `@tauri-apps/api/core`.
fn asset_url(path: &str) -> String {
    let encoded = percent_encode(path);
    if cfg!(any(windows, target_os = "android")) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

fn options(base_dir: Option<&Path>) -> Options<'static> {
    let extension = Extension {
        strikethrough: true,
        table: true,
        autolink: true,
        tasklist: true,
        superscript: true,
        subscript: false,
        footnotes: true,
        description_lists: true,
        front_matter_delimiter: Some("---".to_string()),
        multiline_block_quotes: true,
        alerts: true,
        math_dollars: true,
        math_code: true,
        shortcodes: true,
        underline: false,
        spoiler: false,
        header_id_prefix: Some(String::new()),
        wikilinks_title_after_pipe: true,
        image_url_rewriter: base_dir.map(|d| {
            Arc::new(ImageRewriter {
                base_dir: d.to_path_buf(),
            }) as Arc<dyn URLRewriter>
        }),
        ..Default::default()
    };
    let render = Render {
        r#unsafe: true,
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

pub fn render_markdown(source: &str, base_dir: Option<&Path>) -> String {
    let options = options(base_dir);
    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&*HIGHLIGHTER);
    let mut renderers: HashMap<String, &dyn CodefenceRendererAdapter> = HashMap::new();
    renderers.insert("mermaid".to_string(), &MERMAID);
    plugins.render.codefence_renderers = renderers;
    markdown_to_html_with_plugins(source, &options, &plugins)
}

/// CSS for the class-based highlighter, with a light and a dark theme.
pub fn highlight_css() -> String {
    let themes = ThemeSet::load_defaults();
    let style = ClassStyle::SpacedPrefixed {
        prefix: CLASS_PREFIX,
    };
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

fn scope_highlight_css(css: &str, theme: &str) -> String {
    let prefix = format!(":where(:root[data-theme=\"{theme}\"])");
    // Syntect emits each selector list on one line; scope every list member
    // without CSS nesting or increasing the highlighter's specificity.
    css.lines()
        .map(|line| {
            if line.starts_with('.') {
                format!("{prefix} {}", line.replace(", ", &format!(", {prefix} ")))
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
#[path = "../../tests/render.rs"]
mod tests;
