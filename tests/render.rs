//! Production Comrak/Syntect rendering tests, loaded through render's path module.
//!
//! HTML assertions cover parser extensions, frontend marker contracts, escaping,
//! local asset paths and palette scoping. No browser engines or mocked parser are
//! used; E2E subsequently verifies this real output in the actual frontend.
use super::*;

/// CommonMark/GFM constructs must yield expected markup, stable headings and emoji.
#[cfg_attr(not(doc), test)]
fn renders_commonmark_and_github_features() {
    let html = render_markdown("# Title\n\n**bold** *italic* ~~strike~~ `inline` ^sup^\n\nhttps://example.com :rocket:\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> notice\n", None);
    for expected in [
        // Individually listed fragments identify which parser extension regressed.
        "id=\"title\"",
        "<strong>bold</strong>",
        "<em>italic</em>",
        "<del>strike</del>",
        "<code>inline</code>",
        "<sup>sup</sup>",
        "href=\"https://example.com\"",
        "🚀",
        "checked",
        "<table>",
        "markdown-alert-note",
    ] {
        assert!(html.contains(expected), "missing {expected}: {html}");
    }
}

/// Definition lists, wiki links, footnotes and embedded details survive; front matter stays hidden.
#[cfg_attr(not(doc), test)]
fn renders_extended_features_and_hides_front_matter() {
    let html = render_markdown("---\nsecret: hidden\n---\n# Hello\n\nTerm\n: Definition\n\n[[second.md|Second]]\n\nFootnote[^one].\n\n[^one]: Footnote body.\n\n<details><summary>More</summary>Content</details>\n", None);
    for expected in [
        "<dl>",
        "<dt>Term</dt>",
        "Definition",
        "href=\"second.md\"",
        "Second",
        "footnote",
        "<details>",
        "<summary>More</summary>",
    ] {
        assert!(html.contains(expected), "missing {expected}: {html}");
    }
    assert!(!html.contains("secret: hidden"));
}

/// Math stays marked for Temml, and Mermaid source is escaped rather than interpreted as HTML.
#[cfg_attr(not(doc), test)]
fn emits_math_markers_and_escaped_mermaid_source() {
    let html = render_markdown("$x^2$\n\n$$x+y$$\n\n```math\n\\frac{1}{2}\n```\n\n```mermaid\ngraph TD; A[\"<script>&\"]-->B;\n```\n", None);
    assert!(html.contains("data-math-style=\"inline\""));
    assert!(html.contains("data-math-style=\"display\""));
    assert!(html.contains("<pre class=\"mermaid\">"));
    assert!(html.contains("&lt;script&gt;&amp;"));
    assert!(!html.contains("<script>"));
}

/// Extended language definitions produce class-based highlighting without fixed inline colors.
#[cfg_attr(not(doc), test)]
fn highlights_extended_languages_without_inline_styles() {
    warm_up();
    // These exercise the shared cached highlighter, including two-face's TypeScript syntax.
    for (lang, code) in [
        ("rust", "fn main() {}"),
        ("typescript", "const greet = (name: string) => name;"),
        ("javascript", "const answer = 42;"),
        ("python", "def greet(): return 42"),
    ] {
        let html = render_markdown(&format!("```{lang}\n{code}\n```"), None);
        assert!(html.contains("sx-"), "{lang}: {html}");
        assert!(!html.contains("style="), "{lang}: {html}");
        if lang == "typescript" {
            assert!(html.contains("sx-source sx-ts"), "{html}");
            assert!(
                html.contains("sx-storage") || html.contains("sx-keyword"),
                "{html}"
            );
        }
    }
}

/// Unknown fence languages are escaped readable code; an empty document renders no markup.
#[cfg_attr(not(doc), test)]
fn unknown_languages_and_empty_documents_remain_readable() {
    let html = render_markdown("```unknown-omarkd-language\n<hello>&world\n```", None);
    assert!(html.contains("&lt;hello&gt;&amp;world"));
    assert_eq!(render_markdown("", None), "");
}

/// Relative/local images use Tauri assets while remote, fragment and data URLs remain unchanged.
#[cfg_attr(not(doc), test)]
fn rewrites_document_relative_images_and_preserves_external_urls() {
    let rewrite = ImageRewriter {
        base_dir: PathBuf::from("/tmp/docs"),
    };
    assert_eq!(
        rewrite.to_html("pics/a%20b.png"),
        asset_url("/tmp/docs/pics/a b.png")
    );
    assert_eq!(rewrite.to_html("/tmp/a.png"), asset_url("/tmp/a.png"));
    for url in [
        "",
        "#fragment",
        "//example.com/a.png",
        "https://example.com/a.png",
        "data:image/png;base64,AAAA",
        "asset://localhost/image",
    ] {
        assert_eq!(rewrite.to_html(url), url);
    }
    let html = render_markdown("![img](<pics/a b.png>)", Some(Path::new("/tmp/docs")));
    // Verify both the adapter and its wiring into a complete Markdown render.
    assert!(html.contains(&asset_url("/tmp/docs/pics/a b.png")));
    assert!(render_markdown("![img](pic.png)", None).contains("src=\"pic.png\""));
}

/// Scheme classification must not treat Windows drive letters as an external URL scheme.
#[cfg_attr(not(doc), test)]
fn detects_schemes_and_not_windows_drives() {
    for url in [
        "https://example.com",
        "data:image/png",
        "custom+scheme:value",
    ] {
        assert!(has_scheme(url));
    }
    for url in [
        "C:\\docs\\image.png",
        "/tmp/image.png",
        "relative.png",
        "bad scheme:value",
    ] {
        assert!(!has_scheme(url));
    }
}

/// UTF-8 and reserved bytes round-trip; malformed escapes are retained and invalid bytes decode lossily.
#[cfg_attr(not(doc), test)]
fn percent_encoding_roundtrips_unicode_spaces_and_reserved_characters() {
    for text in ["", "plain-_.~123", "/a b/#%?&", "café/文.md"] {
        assert_eq!(percent_decode(&percent_encode(text)), text);
    }
    assert_eq!(percent_encode("/a b"), "%2Fa%20b");
    assert_eq!(percent_decode("bad%ZZ%2"), "bad%ZZ%2");
    assert_eq!(percent_decode("%FF"), "\u{fffd}");
}

/// HTML-significant characters are escaped while ordinary apostrophes/text stay readable.
#[cfg_attr(not(doc), test)]
fn escapes_html_metacharacters() {
    let mut output = String::new();
    escape_into(&mut output, "<>&\"' text").unwrap();
    assert_eq!(output, "&lt;&gt;&amp;&quot;' text");
}

/// Every generated selector is palette-scoped; manual app themes do not depend on media queries.
#[cfg_attr(not(doc), test)]
fn css_has_both_themes_with_every_selector_scoped() {
    let css = highlight_css();
    assert!(css.contains(":where(:root[data-theme=\"light\"]) .sx-code"));
    assert!(css.contains(":where(:root[data-theme=\"dark\"]) .sx-code"));
    assert!(!css.contains("prefers-color-scheme"));
    for line in css.lines().filter(|line| line.ends_with(" {")) {
        // A comma list must scope every member, not only its first selector.
        for selector in line.trim_end_matches(" {").split(", ") {
            assert!(
                selector.starts_with(":where(:root[data-theme="),
                "{selector}"
            );
        }
    }
}

/// Selector-list and descendant formatting stays exact, with declarations preserved unchanged.
#[cfg_attr(not(doc), test)]
fn scopes_highlight_selector_lists_and_descendants() {
    assert_eq!(
        scope_highlight_css(".sx-string, .sx-source.sx-rust .sx-keyword {\n color: #fff;\n}", "dark"),
        ":where(:root[data-theme=\"dark\"]) .sx-string, :where(:root[data-theme=\"dark\"]) .sx-source.sx-rust .sx-keyword {\n color: #fff;\n}"
    );
}
