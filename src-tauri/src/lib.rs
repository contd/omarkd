//! Omarkd's native application boundary: documents, windows, commands and lifecycle.
//!
//! Each document webview has a unique label. `AppState` uses that label to track
//! its document, directory watcher and optional startup render. TypeScript owns
//! reader/editor interaction; native commands provide file I/O and rendering.
//!
//! Explicit Quit is a handshake: every window must finish saving before exit.
//! A failed save cancels the request, while request IDs reject late acknowledgments.
//! On macOS, closing the last window leaves the app resident for later CLI/Finder use.

/// Conflict-checked UTF-8 reads and atomic file replacement.
mod edit;
/// Markdown parser, image URL handling and reusable syntax-highlighting styles.
mod render;

// Maps track per-window resources; sets track windows still saving during Quit.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
// Atomics allocate IDs/flag exit readiness; mutexes guard shared application state.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

// notify observes filesystem changes; Serde serializes native command responses.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
// Tauri handles expose managed state, webviews, events and desktop lifecycle hooks.
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

/// Native rendering response consumed by the TypeScript document controller.
///
/// `Clone` permits owned copies; Serde converts `render_ms` to `renderMs` for JS.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    /// Normalized source path, also used to identify the document in a window.
    path: String,
    /// Parent directory for relative links, images and the open-dialog default.
    dir: String,
    /// Source filename used in the native title bar.
    title: String,
    /// Parser output; the frontend sanitizes it before inserting it into the DOM.
    html: String,
    /// File-read and native-render duration in milliseconds, not total app latency.
    render_ms: f64,
}

/// Background startup task yielding a rendered document or a user-facing error.
type Prerender = JoinHandle<Result<Document, String>>;

/// Shared state installed into Tauri and accessed by commands and event handlers.
///
/// Each mutex protects one resource collection. Keep guards short and release
/// them before awaiting workers or triggering events that can re-enter the app.
#[derive(Default)]
struct AppState {
    /// Document currently shown in each window, keyed by window label.
    documents: Mutex<HashMap<String, PathBuf>>,
    /// Owned watcher handles; retaining a handle keeps its subscription alive.
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    /// Documents rendered while the webview is still booting.
    prerenders: Mutex<HashMap<String, (PathBuf, Prerender)>>,
    /// Current Quit handshake, or `None` when no coordinated exit is pending.
    quitting: Mutex<Option<QuitRequest>>,
    /// Monotonic request IDs distinguish current responses from cancelled quits.
    quit_counter: AtomicUsize,
    /// Allows the final app.exit call to bypass another save-before-Quit handshake.
    exit_ready: AtomicBool,
}

/// Process-wide source of unique `doc-N` labels and staggered window positions.
///
/// Relaxed ordering suffices for ID allocation; this does not publish shared data.
static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(0);
/// Generated light/dark syntax CSS, cached after its first command invocation.
static HIGHLIGHT_CSS: LazyLock<String> = LazyLock::new(render::highlight_css);

/// One explicit Quit attempt and the windows that have not acknowledged saving.
struct QuitRequest {
    /// Unique attempt ID echoed by the frontend's finish_quit command.
    id: usize,
    /// Window labels awaiting success; any participating window can cancel on failure.
    pending: HashSet<String>,
}

/// Records one save acknowledgment and returns whether the app may now exit.
///
/// Stale request IDs, unknown labels and duplicate replies leave the request
/// unchanged. A failed participating save clears the request; all successful
/// replies clear it and return `true`. The caller must hold the quit-state lock.
fn acknowledge_quit(
    quitting: &mut Option<QuitRequest>,
    request: usize,
    label: &str,
    saved: bool,
) -> bool {
    // Nothing is awaiting acknowledgments after cancellation or completion.
    let Some(pending) = quitting.as_mut() else {
        return false;
    };
    if pending.id != request || !pending.pending.remove(label) {
        // Only a current, still-pending window is allowed to affect this attempt.
        return false;
    }
    if !saved {
        // One failure preserves all windows instead of permitting partial shutdown.
        *quitting = None;
        return false;
    }
    if pending.pending.is_empty() {
        // The last successful acknowledgment authorizes the final exit request.
        *quitting = None;
        return true;
    }
    false
}

/// Reads and renders a document, attaching path metadata and elapsed render time.
///
/// Reader mode tolerates invalid UTF-8 with replacement characters. Editing uses
/// a separate strict reader so that those replacements cannot silently corrupt a save.
/// Read failures include the path for the frontend's error display.
fn load_document(path: &Path) -> Result<Document, String> {
    // Start timing before disk I/O so the toolbar includes reading and parsing.
    let started = std::time::Instant::now();
    let source =
        std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let source = String::from_utf8_lossy(&source);
    let dir = path.parent().unwrap_or(Path::new("/"));
    let html = render::render_markdown(&source, Some(dir));
    Ok(Document {
        // Metadata uses owned strings so the result can cross the command boundary.
        path: path.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        title: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        html,
        render_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Canonicalizes an existing path, preserving the supplied spelling if it fails.
///
/// Resolving symlinks helps detect already-open files. Keeping a missing path
/// allows the subsequent read to report a meaningful document error.
fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Turns command line arguments into document paths, resolving them against `cwd`.
/// A directory argument opens its README if it has one.
///
/// Flag-like arguments are skipped. `file://` prefixes are stripped here; actual
/// Finder URL decoding uses Tauri's URL handling in the `RunEvent::Opened` branch.
/// Directories without a recognized entry document contribute no path.
fn resolve_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|arg| {
            // Native launch inputs can supply a plain path or a file URL prefix.
            let arg = arg
                .strip_prefix("file://")
                .map(str::to_string)
                .unwrap_or(arg);
            let p = PathBuf::from(&arg);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            if p.is_dir() {
                // Prefer canonical README spellings before the fallback index file.
                [
                    "README.md",
                    "readme.md",
                    "Readme.md",
                    "README.markdown",
                    "index.md",
                ]
                .iter()
                .map(|n| p.join(n))
                .find(|c| c.is_file())
            } else {
                Some(normalize(&p))
            }
        })
        .collect()
}

/// Limits webview navigation to app/asset origins and debug development servers.
///
/// External links are opened by the frontend through the native opener plugin,
/// not by replacing the trusted application webview with a remote page.
fn is_allowed_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => true,
        "http" | "https" => {
            // Match complete hosts so a lookalike suffix cannot qualify as internal.
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || host == "asset.localhost"
                || (cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1"))
        }
        _ => false,
    }
}

/// Waits without blocking the async executor's thread.
///
/// The worker pool performs the blocking sleep; callers await its completion.
/// Used only for short startup visibility/Finder-delivery delays.
async fn sleep(duration: Duration) {
    let _ = async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

/// Focuses an already-open document or creates a new hidden, staggered webview.
///
/// A document starts rendering while the webview boots. The frontend reveals the
/// window after painting, with a timed native visibility fallback. Opening a file
/// cancels an in-progress Quit so the new request is not lost during shutdown.
fn open_window(app: &AppHandle, path: Option<PathBuf>) {
    let state = app.state::<AppState>();
    let cancelled = state.quitting.lock().unwrap().take();
    // Release quit state before emitting a cancellation to interactive windows.
    if let Some(request) = cancelled {
        if let Err(e) = app.emit("omarkd://quit-cancelled", request.id) {
            eprintln!("omarkd: could not cancel quit for a new window: {e}");
        }
    }

    if let Some(path) = &path {
        // Clone only the matching label so no map lock is held while focusing.
        let existing = state
            .documents
            .lock()
            .unwrap()
            .iter()
            .find(|(_, p)| *p == path)
            .map(|(label, _)| label.clone());
        if let Some(window) = existing.and_then(|label| app.get_webview_window(&label)) {
            // A duplicate launch reuses the original window and its editor state.
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
    }

    let index = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("doc-{index}");
    let (url, title) = match &path {
        Some(p) => {
            // Move an owned path into the worker; retain the handle for render_file.
            let job_path = p.clone();
            let job = async_runtime::spawn_blocking(move || load_document(&job_path));
            state
                .prerenders
                .lock()
                .unwrap()
                .insert(label.clone(), (p.clone(), job));
            // Register immediately so another launch can identify this document.
            state
                .documents
                .lock()
                .unwrap()
                .insert(label.clone(), p.clone());
            let name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            (
                format!(
                    // Encode the entire filesystem path as one query parameter.
                    "index.html?file={}",
                    render::percent_encode(&p.to_string_lossy())
                ),
                format!("{name} — Omarkd"),
            )
        }
        None => ("index.html".to_string(), "Omarkd".to_string()),
    };

    // Cycle eight offsets rather than pushing every later window off-screen.
    let offset = (index % 8) as f64 * 28.0;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(960.0, 1000.0)
        // The frontend's compact layout is designed for at least 420 px width.
        .min_inner_size(420.0, 320.0)
        .position(120.0 + offset, 60.0 + offset)
        .zoom_hotkeys_enabled(true)
        // Avoid showing an unpainted webview during native/JavaScript startup.
        .visible(false)
        .on_navigation(is_allowed_navigation);

    match builder.build() {
        Ok(window) => {
            // The frontend shows the window once content is painted; this is a safety net.
            async_runtime::spawn(async move {
                sleep(Duration::from_millis(1500)).await;
                if !window.is_visible().unwrap_or(true) {
                    // Treat a failed visibility query as visible to avoid extra focus.
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
        Err(e) => eprintln!("omarkd: failed to open window: {e}"),
    }
}

/// Opens each path in its own document window, or a welcome window for no paths.
fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        open_window(app, None);
    }
    for path in paths {
        open_window(app, Some(path));
    }
}

/// Frontend command that renders a file and registers it for the invoking window.
///
/// A matching startup task is consumed once; later renders use worker-pool I/O.
/// Worker join errors become strings, as do document read failures.
#[tauri::command]
async fn render_file(window: WebviewWindow, path: String) -> Result<Document, String> {
    let path = normalize(Path::new(&path));
    let state = window.state::<AppState>();
    let prerender = {
        // Remove the task under lock, then await it after the guard has been dropped.
        let mut prerenders = state.prerenders.lock().unwrap();
        match prerenders.remove(window.label()) {
            Some((p, job)) if p == path => Some(job),
            _ => None,
        }
    };
    state
        .documents
        .lock()
        .unwrap()
        .insert(window.label().to_string(), path.clone());

    if let Some(job) = prerender {
        if let Ok(doc) = job.await {
            // A successfully joined task may itself carry a document-read error.
            return doc;
        }
        // A task join failure falls back to a fresh render rather than reusing its handle.
    }
    async_runtime::spawn_blocking(move || load_document(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns the shared syntax stylesheet without regenerating it for each window.
#[tauri::command]
fn highlight_css() -> &'static str {
    HIGHLIGHT_CSS.as_str()
}

/// Restricts editor I/O to the normalized document registered for this webview.
///
/// Both source-reading and saving commands call this before dispatching disk I/O.
/// A mismatched document or poisoned state lock returns an explicit command error.
fn editable_path(window: &WebviewWindow, path: &str) -> Result<PathBuf, String> {
    let path = normalize(Path::new(path));
    let state = window.state::<AppState>();
    let documents = state.documents.lock().map_err(|e| e.to_string())?;
    if documents.get(window.label()) != Some(&path) {
        return Err("Can only edit the document open in this window".into());
    }
    Ok(path)
}

/// Reads editable UTF-8 source for the invoking window on a blocking worker.
///
/// Authorization runs first; UTF-8/read failures and worker errors reach the UI.
#[tauri::command]
async fn read_source(window: WebviewWindow, path: String) -> Result<String, String> {
    let path = editable_path(&window, &path)?;
    async_runtime::spawn_blocking(move || edit::read_source(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Saves a window's source with an expected-content comparison on a worker.
///
/// `expected` is the last acknowledged source, not a timestamp. Conflicts return a
/// tagged result with current disk text; I/O failures return command errors.
#[tauri::command]
async fn save_source(
    window: WebviewWindow,
    path: String,
    expected: String,
    source: String,
) -> Result<edit::SaveResult, String> {
    let path = editable_path(&window, &path)?;
    async_runtime::spawn_blocking(move || edit::save_source(&path, &expected, &source))
        .await
        .map_err(|e| e.to_string())?
}

/// Handles a window's save-before-Quit reply and triggers cancellation or exit.
///
/// The request ID and pending label must match. The quit lock is released before
/// emitting cancellation or scheduling final exit, avoiding lifecycle re-entry
/// under the lock. `exit_ready` prevents the final exit from initiating another round.
#[tauri::command]
fn finish_quit(window: WebviewWindow, request: usize, saved: bool) -> Result<(), String> {
    let state = window.state::<AppState>();
    let mut quitting = state.quitting.lock().map_err(|e| e.to_string())?;
    let cancelled = !saved
        && quitting
            .as_ref()
            .is_some_and(|q| q.id == request && q.pending.contains(window.label()));
    let ready = acknowledge_quit(&mut quitting, request, window.label(), saved);
    drop(quitting);
    if cancelled {
        // Frontends leave the inert quitting state and expose any save error.
        window
            .app_handle()
            .emit("omarkd://quit-cancelled", request)
            .map_err(|e| format!("Could not cancel quit: {e}"))?;
    }
    if ready {
        state.exit_ready.store(true, Ordering::Relaxed);
        window.app_handle().exit(0);
    }
    Ok(())
}

/// Watches the document's directory (editors often save via rename) and notifies
/// the window whenever the document changes.
///
/// Watching the directory handles atomic replacement by other editors. Access
/// events are ignored to avoid reloading on our own reads. The frontend debounces
/// notifications and distinguishes reader reloads from editor reconciliation.
/// Watcher setup errors are returned; callback errors are currently ignored.
#[tauri::command]
fn watch_file(window: WebviewWindow, path: String) -> Result<(), String> {
    let path = normalize(Path::new(&path));
    let dir = path
        .parent()
        .ok_or("File has no parent directory")?
        .to_path_buf();
    let file_name = path.file_name().map(|n| n.to_os_string());
    let label = window.label().to_string();
    let target = window.clone();

    // The closure owns its window handle and filename for the subscription lifetime.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        if event
            .paths
            .iter()
            .any(|p| p.file_name().map(|n| n.to_os_string()) == file_name)
        {
            // Only this window receives events for its selected document.
            let _ = target.emit_to(target.label(), "omarkd://file-changed", ());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        // Observe the parent only, not every descendant of the document directory.
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    window
        .state::<AppState>()
        .watchers
        .lock()
        .unwrap()
        .insert(label, watcher);
    // Replacing the stored handle drops the previous subscription for this window.
    Ok(())
}

/// Opens or focuses a normalized document path in a separate native window.
#[tauri::command]
fn open_in_new_window(app: AppHandle, path: String) {
    open_window(&app, Some(normalize(Path::new(&path))));
}

/// Configures native services, creates initial windows and runs the event loop.
///
/// Single-instance CLI launches, Finder file opens and Dock reopens all converge
/// on the same window-opening helpers. Explicit exits use a save acknowledgment
/// protocol; macOS last-window close intentionally does not terminate the process.
///
/// # Panics
///
/// Panics if Tauri cannot build the application from its generated configuration.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm the syntax highlighter while the first webview boots.
    std::thread::spawn(render::warm_up);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // argv[0] is the executable; subsequent arguments belong to this launch.
            let paths = resolve_args(argv.into_iter().skip(1), Path::new(&cwd));
            open_paths(app, paths);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Commands and lifecycle callbacks retrieve this state through Manager.
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            // This registry is the native API surface available to the frontend.
            render_file,
            read_source,
            save_source,
            finish_quit,
            highlight_css,
            watch_file,
            open_in_new_window
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                // Drop subscriptions/tasks and forget the document of a dead webview.
                let state = window.state::<AppState>();
                let label = window.label();
                state.watchers.lock().unwrap().remove(label);
                state.documents.lock().unwrap().remove(label);
                state.prerenders.lock().unwrap().remove(label);
                let mut quitting = state.quitting.lock().unwrap();
                // A window that finished closing no longer needs to reply to Quit.
                let ready = if let Some(request) = quitting.as_ref().map(|q| q.id) {
                    acknowledge_quit(&mut quitting, request, label, true)
                } else {
                    false
                };
                drop(quitting);
                if ready {
                    state.exit_ready.store(true, Ordering::Relaxed);
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            // Resolve relative initial arguments against the launch working directory.
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
            let paths = resolve_args(std::env::args().skip(1), &cwd);
            let handle = app.handle().clone();
            if !paths.is_empty() {
                open_paths(&handle, paths);
            } else if cfg!(target_os = "macos") {
                // Finder delivers files through RunEvent::Opened shortly after launch.
                async_runtime::spawn(async move {
                    sleep(Duration::from_millis(300)).await;
                    if handle.webview_windows().is_empty() {
                        // Do not create an extra welcome window after Finder opened a file.
                        open_window(&handle, None);
                    }
                });
            } else {
                open_window(&handle, None);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Omarkd");

    app.run(|_app, _event| match _event {
        RunEvent::ExitRequested {
            code: Some(_), api, ..
        } => {
            // Explicit exit (Some code) differs from implicit last-window close.
            let state = _app.state::<AppState>();
            if state.exit_ready.load(Ordering::Relaxed) {
                // All participating windows saved; allow the second exit request.
                return;
            }
            let windows = _app.webview_windows();
            if windows.is_empty() {
                // There are no frontend editors left to coordinate.
                return;
            }
            api.prevent_exit();
            let request = {
                let mut quitting = state.quitting.lock().unwrap();
                if quitting.is_some() {
                    // Repeated Quit clicks share the ongoing request.
                    return;
                }
                let id = state.quit_counter.fetch_add(1, Ordering::Relaxed);
                // Capture exactly the windows participating in this save round.
                *quitting = Some(QuitRequest {
                    id,
                    pending: windows.keys().cloned().collect(),
                });
                id
            };
            for window in windows.values() {
                if let Err(e) = window.emit("omarkd://before-quit", request) {
                    eprintln!("omarkd: could not save before quitting: {e}");
                    *state.quitting.lock().unwrap() = None;
                    // If a request cannot be delivered, restore interaction everywhere.
                    if let Err(e) = _app.emit("omarkd://quit-cancelled", request) {
                        eprintln!("omarkd: could not notify windows of cancelled quit: {e}");
                    }
                    break;
                }
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            // Finder supplies parsed URLs; ignore non-file URLs in this event.
            let paths = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| normalize(&p))
                .collect::<Vec<_>>();
            if !paths.is_empty() {
                open_paths(_app, paths);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            // Clicking the Dock icon with no visible windows opens the welcome view.
            if !has_visible_windows {
                open_window(_app, None);
            }
        }
        // Like other macOS document apps, stay resident after the last window closes
        // so the next `omarkd file.md` opens instantly.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        _ => {}
    });
}

/// Native state, argument handling and lifecycle-helper tests in the root suite.
#[cfg(test)]
#[path = "../../tests/backend.rs"]
mod tests;
