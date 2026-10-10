mod edit;
mod render;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    path: String,
    dir: String,
    title: String,
    html: String,
    render_ms: f64,
}

type Prerender = JoinHandle<Result<Document, String>>;

#[derive(Default)]
struct AppState {
    /// Document currently shown in each window, keyed by window label.
    documents: Mutex<HashMap<String, PathBuf>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    /// Documents rendered while the webview is still booting.
    prerenders: Mutex<HashMap<String, (PathBuf, Prerender)>>,
    quitting: Mutex<Option<QuitRequest>>,
    quit_counter: AtomicUsize,
    exit_ready: AtomicBool,
}

static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(0);
static HIGHLIGHT_CSS: LazyLock<String> = LazyLock::new(render::highlight_css);

struct QuitRequest {
    id: usize,
    pending: HashSet<String>,
}

fn acknowledge_quit(
    quitting: &mut Option<QuitRequest>,
    request: usize,
    label: &str,
    saved: bool,
) -> bool {
    let Some(pending) = quitting.as_mut() else {
        return false;
    };
    if pending.id != request || !pending.pending.remove(label) {
        return false;
    }
    if !saved {
        *quitting = None;
        return false;
    }
    if pending.pending.is_empty() {
        *quitting = None;
        return true;
    }
    false
}

fn load_document(path: &Path) -> Result<Document, String> {
    let started = std::time::Instant::now();
    let source =
        std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let source = String::from_utf8_lossy(&source);
    let dir = path.parent().unwrap_or(Path::new("/"));
    let html = render::render_markdown(&source, Some(dir));
    Ok(Document {
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

fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Turns command line arguments into document paths, resolving them against `cwd`.
/// A directory argument opens its README if it has one.
fn resolve_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|arg| {
            let arg = arg
                .strip_prefix("file://")
                .map(str::to_string)
                .unwrap_or(arg);
            let p = PathBuf::from(&arg);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            if p.is_dir() {
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

fn is_allowed_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || host == "asset.localhost"
                || (cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1"))
        }
        _ => false,
    }
}

async fn sleep(duration: Duration) {
    let _ = async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

fn open_window(app: &AppHandle, path: Option<PathBuf>) {
    let state = app.state::<AppState>();
    let cancelled = state.quitting.lock().unwrap().take();
    if let Some(request) = cancelled {
        if let Err(e) = app.emit("omarkd://quit-cancelled", request.id) {
            eprintln!("omarkd: could not cancel quit for a new window: {e}");
        }
    }

    if let Some(path) = &path {
        let existing = state
            .documents
            .lock()
            .unwrap()
            .iter()
            .find(|(_, p)| *p == path)
            .map(|(label, _)| label.clone());
        if let Some(window) = existing.and_then(|label| app.get_webview_window(&label)) {
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
            let job_path = p.clone();
            let job = async_runtime::spawn_blocking(move || load_document(&job_path));
            state
                .prerenders
                .lock()
                .unwrap()
                .insert(label.clone(), (p.clone(), job));
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
                    "index.html?file={}",
                    render::percent_encode(&p.to_string_lossy())
                ),
                format!("{name} — Omarkd"),
            )
        }
        None => ("index.html".to_string(), "Omarkd".to_string()),
    };

    let offset = (index % 8) as f64 * 28.0;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(960.0, 1000.0)
        .min_inner_size(420.0, 320.0)
        .position(120.0 + offset, 60.0 + offset)
        .zoom_hotkeys_enabled(true)
        .visible(false)
        .on_navigation(is_allowed_navigation);

    match builder.build() {
        Ok(window) => {
            // The frontend shows the window once content is painted; this is a safety net.
            async_runtime::spawn(async move {
                sleep(Duration::from_millis(1500)).await;
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
        Err(e) => eprintln!("omarkd: failed to open window: {e}"),
    }
}

fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        open_window(app, None);
    }
    for path in paths {
        open_window(app, Some(path));
    }
}

#[tauri::command]
async fn render_file(window: WebviewWindow, path: String) -> Result<Document, String> {
    let path = normalize(Path::new(&path));
    let state = window.state::<AppState>();
    let prerender = {
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
            return doc;
        }
    }
    async_runtime::spawn_blocking(move || load_document(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn highlight_css() -> &'static str {
    HIGHLIGHT_CSS.as_str()
}

fn editable_path(window: &WebviewWindow, path: &str) -> Result<PathBuf, String> {
    let path = normalize(Path::new(path));
    let state = window.state::<AppState>();
    let documents = state.documents.lock().map_err(|e| e.to_string())?;
    if documents.get(window.label()) != Some(&path) {
        return Err("Can only edit the document open in this window".into());
    }
    Ok(path)
}

#[tauri::command]
async fn read_source(window: WebviewWindow, path: String) -> Result<String, String> {
    let path = editable_path(&window, &path)?;
    async_runtime::spawn_blocking(move || edit::read_source(&path))
        .await
        .map_err(|e| e.to_string())?
}

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
            let _ = target.emit_to(target.label(), "omarkd://file-changed", ());
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    window
        .state::<AppState>()
        .watchers
        .lock()
        .unwrap()
        .insert(label, watcher);
    Ok(())
}

#[tauri::command]
fn open_in_new_window(app: AppHandle, path: String) {
    open_window(&app, Some(normalize(Path::new(&path))));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm the syntax highlighter while the first webview boots.
    std::thread::spawn(render::warm_up);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = resolve_args(argv.into_iter().skip(1), Path::new(&cwd));
            open_paths(app, paths);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
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
                let state = window.state::<AppState>();
                let label = window.label();
                state.watchers.lock().unwrap().remove(label);
                state.documents.lock().unwrap().remove(label);
                state.prerenders.lock().unwrap().remove(label);
                let mut quitting = state.quitting.lock().unwrap();
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
            let state = _app.state::<AppState>();
            if state.exit_ready.load(Ordering::Relaxed) {
                return;
            }
            let windows = _app.webview_windows();
            if windows.is_empty() {
                return;
            }
            api.prevent_exit();
            let request = {
                let mut quitting = state.quitting.lock().unwrap();
                if quitting.is_some() {
                    return;
                }
                let id = state.quit_counter.fetch_add(1, Ordering::Relaxed);
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
                    if let Err(e) = _app.emit("omarkd://quit-cancelled", request) {
                        eprintln!("omarkd: could not notify windows of cancelled quit: {e}");
                    }
                    break;
                }
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
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

#[cfg(test)]
#[path = "../../tests/backend.rs"]
mod tests;
