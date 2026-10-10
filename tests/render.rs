use super::*;

#[test]
fn renders_commonmark_and_github_features() {
    let html = render_markdown("# Title\n\n**bold** *italic* ~~strike~~ `inline` ^sup^\n\nhttps://example.com :rocket:\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> notice\n", None);
    for expected in [
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

#[test]
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

#[test]
fn emits_math_markers_and_escaped_mermaid_source() {
    let html = render_markdown("$x^2$\n\n$$x+y$$\n\n```math\n\\frac{1}{2}\n```\n\n```mermaid\ngraph TD; A[\"<script>&\"]-->B;\n```\n", None);
    assert!(html.contains("data-math-style=\"inline\""));
    assert!(html.contains("data-math-style=\"display\""));
    assert!(html.contains("<pre class=\"mermaid\">"));
    assert!(html.contains("&lt;script&gt;&amp;"));
    assert!(!html.contains("<script>"));
}

#[test]
fn highlights_extended_languages_without_inline_styles() {
    warm_up();
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

#[test]
fn unknown_languages_and_empty_documents_remain_readable() {
    let html = render_markdown("```unknown-omarkd-language\n<hello>&world\n```", None);
    assert!(html.contains("&lt;hello&gt;&amp;world"));
    assert_eq!(render_markdown("", None), "");
}

#[test]
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
    assert!(html.contains(&asset_url("/tmp/docs/pics/a b.png")));
    assert!(render_markdown("![img](pic.png)", None).contains("src=\"pic.png\""));
}

#[test]
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

#[test]
fn percent_encoding_roundtrips_unicode_spaces_and_reserved_characters() {
    for text in ["", "plain-_.~123", "/a b/#%?&", "café/文.md"] {
        assert_eq!(percent_decode(&percent_encode(text)), text);
    }
    assert_eq!(percent_encode("/a b"), "%2Fa%20b");
    assert_eq!(percent_decode("bad%ZZ%2"), "bad%ZZ%2");
    assert_eq!(percent_decode("%FF"), "\u{fffd}");
}

#[test]
fn escapes_html_metacharacters() {
    let mut output = String::new();
    escape_into(&mut output, "<>&\"' text").unwrap();
    assert_eq!(output, "&lt;&gt;&amp;&quot;' text");
}

#[test]
fn css_has_both_themes_with_every_selector_scoped() {
    let css = highlight_css();
    assert!(css.contains(":where(:root[data-theme=\"light\"]) .sx-code"));
    assert!(css.contains(":where(:root[data-theme=\"dark\"]) .sx-code"));
    assert!(!css.contains("prefers-color-scheme"));
    for line in css.lines().filter(|line| line.ends_with(" {")) {
        for selector in line.trim_end_matches(" {").split(", ") {
            assert!(
                selector.starts_with(":where(:root[data-theme="),
                "{selector}"
            );
        }
    }
}

#[test]
fn scopes_highlight_selector_lists_and_descendants() {
    assert_eq!(
        scope_highlight_css(".sx-string, .sx-source.sx-rust .sx-keyword {\n color: #fff;\n}", "dark"),
        ":where(:root[data-theme=\"dark\"]) .sx-string, :where(:root[data-theme=\"dark\"]) .sx-source.sx-rust .sx-keyword {\n color: #fff;\n}"
    );
}
