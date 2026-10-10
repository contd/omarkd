use super::*;

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "omarkd-tests-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn resolves_relative_absolute_and_file_url_args_and_skips_flags() {
    let tmp = TempDirectory::new();
    let absolute = tmp.0.join("absolute.md");
    let paths = resolve_args(
        vec![
            "-psn_0_123".into(),
            "--ignored".into(),
            "notes.md".into(),
            absolute.to_string_lossy().into_owned(),
            format!("file://{}", absolute.display()),
        ],
        &tmp.0,
    );
    assert_eq!(
        paths,
        vec![tmp.0.join("notes.md"), absolute.clone(), absolute]
    );
    assert!(resolve_args(Vec::<String>::new(), &tmp.0).is_empty());
}

#[test]
fn directory_args_choose_readme_in_priority_order_and_skip_empty_directories() {
    let tmp = TempDirectory::new();
    assert!(resolve_args(vec![".".into()], &tmp.0).is_empty());
    for name in ["index.md", "README.markdown", "README.md"] {
        std::fs::write(tmp.0.join(name), "# Readme").unwrap();
        assert_eq!(
            resolve_args(vec![".".into()], &tmp.0),
            vec![tmp.0.join(".").join(name)]
        );
    }
}

#[test]
fn normalizes_existing_paths_but_preserves_missing_paths() {
    let tmp = TempDirectory::new();
    std::fs::write(tmp.0.join("notes.md"), "# Notes").unwrap();
    assert_eq!(
        normalize(&tmp.0.join("./notes.md")),
        std::fs::canonicalize(tmp.0.join("notes.md")).unwrap()
    );
    let missing = tmp.0.join("missing.md");
    assert_eq!(normalize(&missing), missing);
}

#[test]
fn loads_document_metadata_html_and_utf8_lossily() {
    let tmp = TempDirectory::new();
    let path = tmp.0.join("notes.md");
    std::fs::write(&path, b"# Notes\n\ninvalid byte: \xff").unwrap();
    let doc = load_document(&path).unwrap();
    assert_eq!(doc.path, path.to_string_lossy());
    assert_eq!(doc.dir, tmp.0.to_string_lossy());
    assert_eq!(doc.title, "notes.md");
    assert!(doc.html.contains("id=\"notes\""));
    assert!(doc.html.contains('\u{fffd}'));
    assert!(doc.render_ms.is_finite() && doc.render_ms >= 0.0);
    let json = serde_json::to_value(&doc).unwrap();
    assert!(json.get("renderMs").is_some());
    assert_eq!(json.as_object().unwrap().len(), 5);
}

#[test]
fn reports_missing_or_unreadable_documents() {
    let tmp = TempDirectory::new();
    let missing = tmp.0.join("missing.md");
    let error = load_document(&missing).unwrap_err();
    assert!(error.contains("Could not read") && error.contains("missing.md"));
    assert!(load_document(&tmp.0).is_err());
}

#[test]
fn navigation_allows_only_internal_urls_and_debug_loopback() {
    for url in [
        "tauri://localhost/index.html",
        "asset://localhost/image.png",
        "http://tauri.localhost",
        "https://asset.localhost",
    ] {
        assert!(is_allowed_navigation(&url.parse().unwrap()), "{url}");
    }
    for url in [
        "https://example.com",
        "https://tauri.localhost.evil.test",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hello",
    ] {
        assert!(!is_allowed_navigation(&url.parse().unwrap()), "{url}");
    }
    for url in ["http://localhost:1420", "http://127.0.0.1:1420"] {
        assert_eq!(
            is_allowed_navigation(&url.parse().unwrap()),
            cfg!(debug_assertions)
        );
    }
}

#[test]
fn app_state_starts_empty() {
    let state = AppState::default();
    assert!(state.documents.lock().unwrap().is_empty());
    assert!(state.watchers.lock().unwrap().is_empty());
    assert!(state.prerenders.lock().unwrap().is_empty());
    assert!(state.quitting.lock().unwrap().is_none());
    assert!(!state.exit_ready.load(Ordering::Relaxed));
}

#[test]
fn quit_requires_every_window_and_ignores_stale_or_duplicate_responses() {
    let mut request = Some(QuitRequest {
        id: 2,
        pending: ["first".into(), "second".into()].into(),
    });
    assert!(!acknowledge_quit(&mut request, 1, "first", false));
    assert!(!acknowledge_quit(&mut request, 2, "unknown", false));
    assert!(!acknowledge_quit(&mut request, 2, "first", true));
    assert!(!acknowledge_quit(&mut request, 2, "first", false));
    assert!(acknowledge_quit(&mut request, 2, "second", true));
    assert!(request.is_none());
    assert!(!acknowledge_quit(&mut request, 2, "second", true));
}

#[test]
fn one_failed_save_cancels_quit_and_late_success_cannot_exit() {
    let mut request = Some(QuitRequest {
        id: 3,
        pending: ["first".into(), "second".into()].into(),
    });
    assert!(!acknowledge_quit(&mut request, 3, "first", false));
    assert!(request.is_none());
    assert!(!acknowledge_quit(&mut request, 3, "second", true));
}
