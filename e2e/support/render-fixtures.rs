#[path = "../../src-tauri/src/render.rs"]
mod render;

use std::collections::BTreeMap;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(file) = std::env::args().nth(1) {
        let source = std::fs::read_to_string(file)?;
        print!(
            "{}",
            render::render_markdown(&source, Some(Path::new("/documents")))
        );
        return Ok(());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut documents = BTreeMap::new();
    render::warm_up();
    for entry in std::fs::read_dir(root.join("e2e/fixtures"))? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
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
                "renderMs": 1.0
            }),
        );
    }
    let output = root.join("e2e/.generated");
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
