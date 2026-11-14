#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analyze;

use analyze::Photo;
use rayon::prelude::*;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, AppHandle, Manager, State};

#[derive(Default)]
struct AppState {
    cancel: Arc<AtomicBool>,
    /// Paths found by the last scan. Only these may be deleted.
    known: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum ScanEvent {
    Total { total: usize },
    Progress { done: usize, total: usize, failed: usize },
    Photos { items: Vec<Photo> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    failed: Vec<String>,
    cancelled: bool,
}

#[tauri::command]
async fn scan(
    app: AppHandle,
    state: State<'_, AppState>,
    folders: Vec<String>,
    recursive: bool,
    on_event: Channel<ScanEvent>,
) -> Result<ScanResult, String> {
    let cancel = state.cancel.clone();
    let known = state.known.clone();
    cancel.store(false, SeqCst);

    let thumb_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    fs::create_dir_all(&thumb_dir).map_err(|e| e.to_string())?;

    // Let the webview load thumbnails and full-size previews through asset://
    let scope = app.asset_protocol_scope();
    scope.allow_directory(&thumb_dir, true).map_err(|e| e.to_string())?;
    for f in &folders {
        scope.allow_directory(f, true).map_err(|e| e.to_string())?;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let files = analyze::collect(&folders, recursive);
        let total = files.len();
        let _ = on_event.send(ScanEvent::Total { total });

        let done = AtomicUsize::new(0);
        let failed = Mutex::new(Vec::<String>::new());
        let batch = Mutex::new(Vec::<Photo>::new());
        known.lock().unwrap().clear();

        // Photos are streamed to the UI in small batches while the scan runs.
        let flush = |items: Vec<Photo>| {
            if items.is_empty() {
                return;
            }
            known.lock().unwrap().extend(items.iter().map(|p| PathBuf::from(&p.path)));
            let _ = on_event.send(ScanEvent::Photos { items });
        };

        files.par_iter().for_each(|p| {
            if cancel.load(SeqCst) {
                return;
            }
            match analyze::analyze(p, &thumb_dir) {
                Ok(photo) => {
                    let ready = {
                        let mut b = batch.lock().unwrap();
                        b.push(photo);
                        if b.len() >= 16 { Some(std::mem::take(&mut *b)) } else { None }
                    };
                    if let Some(items) = ready {
                        flush(items);
                    }
                }
                Err(e) => failed.lock().unwrap().push(e),
            }
            let d = done.fetch_add(1, SeqCst) + 1;
            if d % 8 == 0 || d == total {
                let _ = on_event.send(ScanEvent::Progress {
                    done: d,
                    total,
                    failed: failed.lock().unwrap().len(),
                });
            }
        });
        flush(std::mem::take(&mut *batch.lock().unwrap()));

        ScanResult {
            failed: failed.into_inner().unwrap(),
            cancelled: cancel.load(SeqCst),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    state.cancel.store(true, SeqCst);
}

#[derive(Serialize)]
struct DeleteError {
    path: String,
    error: String,
}

#[derive(Serialize)]
struct DeleteResult {
    deleted: Vec<String>,
    errors: Vec<DeleteError>,
}

fn to_trash(p: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        // NSFileManager: no Finder automation prompt, much faster.
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(p).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn delete_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
    permanent: bool,
) -> Result<DeleteResult, String> {
    let known = state.known.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut res = DeleteResult { deleted: vec![], errors: vec![] };
        for s in paths {
            let p = PathBuf::from(&s);
            // Safety: only files that the scan reported can be removed.
            if !known.lock().unwrap().contains(&p) {
                res.errors.push(DeleteError { path: s, error: "not part of the last scan".into() });
                continue;
            }
            let r = if permanent {
                fs::remove_file(&p).map_err(|e| e.to_string())
            } else {
                to_trash(&p)
            };
            match r {
                Ok(()) => {
                    known.lock().unwrap().remove(&p);
                    res.deleted.push(s);
                }
                Err(error) => res.errors.push(DeleteError { path: s, error }),
            }
        }
        res
    })
    .await
    .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![scan, cancel_scan, delete_files])
        .run(tauri::generate_context!())
        .expect("error while running PhotoCleaner");
}
