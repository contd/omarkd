//! Real file-I/O tests for strict reads and conflict-aware atomic replacement.
//!
//! Every case owns a tempfile directory; no user document is touched. Assertions
//! check bytes, permissions, conflict contents and temporary-file cleanup, not
//! merely successful return values. These tests are loaded by edit's path module.
use super::*;

/// Unicode, BOM and CRLF survive a save; no-op and empty-source saves remain valid.
#[test]
fn saves_utf8_atomically_and_keeps_newlines_bom_and_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.md");
    let original = "\u{feff}# café\r\n\r\nText\r\n";
    std::fs::write(&path, original).unwrap();
    let permissions = std::fs::metadata(&path).unwrap().permissions();
    // Comparing exact strings detects accidental lossy conversion or newline rewriting.
    let edited = "\u{feff}# 文\r\n\r\nEdited\r\n";
    assert!(matches!(
        save_source(&path, original, edited).unwrap(),
        SaveResult::Saved
    ));
    assert_eq!(read_source(&path).unwrap(), edited);
    assert_eq!(std::fs::metadata(&path).unwrap().permissions(), permissions);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    // A completed replacement must leave only the original filename, not its temporary file.
    assert!(matches!(
        save_source(&path, edited, edited).unwrap(),
        SaveResult::Saved
    ));
    assert!(matches!(
        save_source(&path, edited, "").unwrap(),
        SaveResult::Saved
    ));
    assert_eq!(read_source(&path).unwrap(), "");
}

/// External writes never get replaced until the supplied expected snapshot agrees.
///
/// Changing disk twice proves an explicit overwrite still performs conflict detection.
#[test]
fn conflicts_never_overwrite_external_edits_and_explicit_resolution_rechecks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.md");
    std::fs::write(&path, "# External").unwrap();
    let result = save_source(&path, "# Original", "# My edits").unwrap();
    assert!(matches!(result, SaveResult::Conflict { source } if source == "# External"));
    assert_eq!(read_source(&path).unwrap(), "# External");
    std::fs::write(&path, "# New external edit").unwrap();
    assert!(matches!(
        save_source(&path, "# External", "# My edits").unwrap(),
        SaveResult::Conflict { .. }
    ));
    assert!(matches!(
        save_source(&path, "# New external edit", "# My edits").unwrap(),
        SaveResult::Saved
    ));
    assert_eq!(read_source(&path).unwrap(), "# My edits");
}

/// Missing paths, directories and invalid UTF-8 fail without creating/replacing files.
#[test]
fn rejects_missing_files_directories_and_invalid_utf8_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.md");
    assert!(read_source(&path).unwrap_err().contains("for editing"));
    assert!(save_source(&path, "", "new").is_err());
    assert!(!path.exists());
    assert!(read_source(dir.path()).is_err());
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    // The original invalid bytes must remain intact even though reader mode is lossy.
    assert!(read_source(&path).is_err());
    assert!(save_source(&path, "", "edited").is_err());
    assert_eq!(std::fs::read(&path).unwrap(), [0xff, 0xfe]);
}

/// Invalid paths and read-only permissions return errors while preserving original data.
#[test]
fn reports_write_errors_and_keeps_original_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.md");
    std::fs::write(&path, "# Original").unwrap();
    // An embedded NUL makes the path invalid on every platform.
    let invalid = dir.path().join("bad\0path");
    assert!(save_source(&invalid, "", "new").is_err());
    assert_eq!(read_source(&path).unwrap(), "# Original");
    let original_permissions = std::fs::metadata(&path).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&path, readonly).unwrap();
    // Directory rename permissions must not bypass the source file's read-only policy.
    assert!(save_source(&path, "# Original", "# New")
        .unwrap_err()
        .contains("read-only"));
    assert_eq!(read_source(&path).unwrap(), "# Original");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    // Restore permissions so tempfile can clean up on platforms enforcing read-only deletion.
    std::fs::set_permissions(&path, original_permissions).unwrap();
}
