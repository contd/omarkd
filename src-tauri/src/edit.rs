use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

static SAVES: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResult {
    Saved,
    Conflict { source: String },
}

pub fn read_source(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map_err(|e| format!("Could not read {} for editing: {e}", path.display()))
}

pub fn save_source(path: &Path, expected: &str, source: &str) -> Result<SaveResult, String> {
    let _guard = SAVES
        .lock()
        .map_err(|e| format!("Could not lock document save: {e}"))?;
    let disk = read_source(path)?;
    if disk != expected {
        return Ok(SaveResult::Conflict { source: disk });
    }
    if source == expected {
        return Ok(SaveResult::Saved);
    }
    let write = || -> std::io::Result<SaveResult> {
        let permissions = std::fs::metadata(path)?.permissions();
        if permissions.readonly() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Document is read-only",
            ));
        }
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))?;
        temp.as_file().set_permissions(permissions)?;
        temp.write_all(source.as_bytes())?;
        temp.as_file().sync_all()?;
        // Recheck after preparing the replacement to narrow the external-write race.
        let latest = read_source(path).map_err(std::io::Error::other)?;
        if latest != expected {
            return Ok(SaveResult::Conflict { source: latest });
        }
        temp.persist(path).map_err(|e| e.error)?;
        Ok(SaveResult::Saved)
    };
    write().map_err(|e| format!("Could not save {}: {e}", path.display()))
}

#[cfg(test)]
#[path = "../../tests/edit.rs"]
mod tests;
