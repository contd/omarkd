//! Browser fixture builder using Omarkd's production Markdown parser/highlighter.
//!
//! The browser only mocks desktop APIs, not Rust rendering. Default invocation
//! writes deterministic document/CSS fixtures for global setup. A single file
//! argument renders edited source through the same pipeline for the browser bridge.

/// Import the maintained renderer rather than a browser-only parser substitute.
#[path = "../../src-tauri/src/render.rs"]
mod render;

use std::collections::BTreeMap;
use std::path::Path;

/// Produces fixture JSON or one rendered Markdown response, propagating I/O failures.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(file) = std::env::args().nth(1) {
        // Exposed Playwright binding writes a disposable UTF-8 file for edited text.
        let source = std::fs::read_to_string(file)?;
        print!(
            "{}",
            render::render_markdown(&source, Some(Path::new("/documents")))
        );
        return Ok(());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // Ordered keys keep the generated JSON stable across filesystem iteration orders.
    let mut documents = BTreeMap::new();
    render::warm_up();
    for entry in std::fs::read_dir(root.join("e2e/fixtures"))? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            // SVG and other passive assets are served directly, not parsed as Markdown.
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy();
        let source = std::fs::read_to_string(&path)?;
        documents.insert(
            format!("/documents/{name}"),
            serde_json::json!({
                "path": format!("/documents/{name}"),
                "dir": "/documents",
                "title": name,
                "html": render::render_markdown(&source, Some(Path::new("/documents"))),
                "source": source,
                // UI timing is fixed so screenshots do not change with compiler/runtime load.
                "renderMs": 1.0
            }),
        );
    }
    let output = root.join("e2e/.generated");
    // Generated input is ignored by Git and regenerated before every browser run.
    std::fs::create_dir_all(&output)?;
    std::fs::write(
        output.join("documents.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "documents": documents,
            "highlightCss": render::highlight_css()
        }))?,
    )?;
    Ok(())
}
