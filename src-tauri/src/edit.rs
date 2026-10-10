//! Strict UTF-8 source reads and conflict-aware replacement of Markdown files.
//!
//! The frontend supplies the last source it successfully read or saved as
//! `expected`. Comparing that snapshot with disk avoids overwriting an external
//! edit without an explicit frontend decision. This module performs file I/O;
//! authorization of the invoking window belongs to the command layer in the crate.
//!
//! Saves are serialized within this process, not across unrelated editors.
//! Temporary files keep failed writes from truncating the original document.

// Write supplies write_all; Path borrows filesystem paths without allocating.
use std::io::Write;
use std::path::Path;
// Mutex coordinates saves submitted by different webviews and worker threads.
use std::sync::Mutex;

// Serialize turns command results into the JSON consumed by TypeScript.
use serde::Serialize;

/// Process-wide save lock, held across the read/compare/write/replace sequence.
///
/// The protected value is `()` because the lock guards an operation, not data.
/// External applications do not acquire this lock and can still race a save.
static SAVES: Mutex<()> = Mutex::new(());

/// A successful save attempt or an external-change conflict requiring a decision.
///
/// Serde's tagged representation matches the frontend's `SaveResult` union:
/// `{"kind":"saved"}` or `{"kind":"conflict","source":"..."}`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveResult {
    /// Disk already matched the requested source, or replacement completed.
    Saved,
    /// Disk differed from the caller's expected snapshot; no replacement occurred.
    Conflict {
        /// Latest source read from disk, used to reload or explicitly overwrite.
        source: String,
    },
}

/// Reads the complete file as UTF-8, preserving its BOM and line-ending bytes.
///
/// Unlike reader-mode rendering, editing rejects invalid UTF-8 rather than
/// introducing replacement characters that might later be saved over real data.
///
/// # Errors
///
/// Returns a path-qualified message on unreadable files or invalid UTF-8.
pub fn read_source(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map_err(|e| format!("Could not read {} for editing: {e}", path.display()))
}

/// Saves `source` only when disk still contains the caller's `expected` source.
///
/// A same-directory temporary file is written and synced before replacing the
/// original. File permissions are retained, but inode identity, hard links, and
/// extended filesystem metadata are not guaranteed to survive replacement.
///
/// The second comparison narrows, but does not eliminate, the race with external
/// writers between the final read and replacement. No inter-process lock is used.
///
/// # Errors
///
/// Returns a descriptive message for a poisoned save lock, read/UTF-8 errors,
/// read-only files, or failed temporary-file creation, writing, sync, or persist.
/// A differing disk snapshot is a [`SaveResult::Conflict`], not an I/O error.
pub fn save_source(path: &Path, expected: &str, source: &str) -> Result<SaveResult, String> {
    // Keep the guard alive until return so two Omarkd saves cannot interleave.
    let _guard = SAVES
        .lock()
        .map_err(|e| format!("Could not lock document save: {e}"))?;
    let disk = read_source(path)?;
    // Compare before treating an unchanged local draft as a successful no-op.
    if disk != expected {
        return Ok(SaveResult::Conflict { source: disk });
    }
    if source == expected {
        // No write is required when the disk and desired contents already agree.
        return Ok(SaveResult::Saved);
    }
    // Keep low-level I/O errors inside the closure, then add the document path.
    let write = || -> std::io::Result<SaveResult> {
        let permissions = std::fs::metadata(path)?.permissions();
        if permissions.readonly() {
            // A writable parent could permit rename over a read-only file; refuse it.
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Document is read-only",
            ));
        }
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))?;
        // Using the document directory keeps replacement on the same filesystem.
        temp.as_file().set_permissions(permissions)?;
        // Write every UTF-8 byte and sync file contents before replacing the original.
        temp.write_all(source.as_bytes())?;
        temp.as_file().sync_all()?;
        // Recheck after preparing the replacement to narrow the external-write race.
        let latest = read_source(path).map_err(std::io::Error::other)?;
        if latest != expected {
            // Returning drops the temporary file; the original remains untouched.
            return Ok(SaveResult::Conflict { source: latest });
        }
        // persist consumes the temporary file and replaces the destination.
        // This syncs the file, not its parent directory: full crash durability is
        // not guaranteed on every filesystem.
        temp.persist(path).map_err(|e| e.error)?;
        Ok(SaveResult::Saved)
    };
    write().map_err(|e| format!("Could not save {}: {e}", path.display()))
}

/// File-I/O regression tests kept in the repository-wide unit test directory.
#[cfg(test)]
#[path = "../../tests/edit.rs"]
mod tests;
