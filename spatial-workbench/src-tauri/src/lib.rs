use notify::{recommended_watcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
struct DesktopRuntimeInfo {
    app_name: &'static str,
    runtime: &'static str,
    shell_available: bool,
}

#[derive(Serialize)]
struct RuntimeConfig {
    hermes_cli_path: String,
    hermes_workdir: String,
    hermes_endpoint_url: Option<String>,
    terminal_idle_ttl_seconds: u64,
}

#[derive(Deserialize)]
struct ShellCommandRequest {
    command: String,
    cwd: Option<String>,
}

#[derive(Serialize)]
struct ShellCommandResult {
    ok: bool,
    command: String,
    cwd: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u128,
}

#[derive(Clone, Serialize)]
struct ShellCommandStreamEvent {
    job_id: String,
    stream: &'static str,
    chunk: String,
    done: bool,
    exit_code: Option<i32>,
}

#[derive(Default)]
struct WatchRegistry {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Clone, Serialize)]
struct WorkspaceFileEvent {
    watch_id: String,
    kind: String,
    paths: Vec<String>,
}

#[tauri::command]
fn get_desktop_runtime_info() -> DesktopRuntimeInfo {
    DesktopRuntimeInfo {
        app_name: "AI Workbench",
        runtime: "tauri-v2",
        shell_available: std::path::Path::new("/bin/bash").exists(),
    }
}

#[tauri::command]
fn get_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        hermes_cli_path: env::var("HERMES_CLI_PATH").unwrap_or_else(|_| "hermes".to_string()),
        hermes_workdir: env::var("HERMES_WORKDIR")
            .unwrap_or_else(|_| home_dir().join(".hermes").display().to_string()),
        hermes_endpoint_url: env::var("HERMES_ENDPOINT_URL").ok().filter(|value| !value.trim().is_empty()),
        terminal_idle_ttl_seconds: env::var("TERMINAL_IDLE_TTL_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(7200),
    }
}

#[tauri::command]
fn execute_shell_command(request: ShellCommandRequest) -> Result<ShellCommandResult, String> {
    let command = request.command.trim();
    if command.is_empty() {
        return Err("command is required".to_string());
    }

    if command_is_high_impact(command) {
        return Err("command requires an approval gate before execution".to_string());
    }

    let cwd = request
        .cwd
        .map(PathBuf::from)
        .unwrap_or_else(default_workdir);

    if !cwd.is_dir() {
        return Err(format!("working directory is not available: {}", cwd.display()));
    }

    let started_at = Instant::now();
    let output = Command::new("/bin/bash")
        .arg("-lc")
        .arg(command)
        .current_dir(&cwd)
        .output()
        .map_err(|error| format!("failed to execute command: {error}"))?;

    Ok(ShellCommandResult {
        ok: output.status.success(),
        command: command.to_string(),
        cwd: cwd.display().to_string(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        duration_ms: started_at.elapsed().as_millis(),
    })
}

#[tauri::command]
fn start_shell_command_stream(app: AppHandle, request: ShellCommandRequest) -> Result<String, String> {
    let command = request.command.trim();
    if command.is_empty() {
        return Err("command is required".to_string());
    }

    if command_is_high_impact(command) {
        return Err("command requires an approval gate before execution".to_string());
    }

    let cwd = request
        .cwd
        .map(PathBuf::from)
        .unwrap_or_else(default_workdir);

    if !cwd.is_dir() {
        return Err(format!("working directory is not available: {}", cwd.display()));
    }

    let job_id = create_job_id();
    let command_string = command.to_string();
    let returned_job_id = job_id.clone();

    thread::spawn(move || {
        emit_shell_event(
            &app,
            ShellCommandStreamEvent {
                job_id: job_id.clone(),
                stream: "status",
                chunk: format!("started in {}", cwd.display()),
                done: false,
                exit_code: None,
            },
        );

        let mut child = match Command::new("/bin/bash")
            .arg("-lc")
            .arg(&command_string)
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                emit_shell_event(
                    &app,
                    ShellCommandStreamEvent {
                        job_id,
                        stream: "error",
                        chunk: format!("failed to execute command: {error}"),
                        done: true,
                        exit_code: None,
                    },
                );
                return;
            }
        };

        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(spawn_stream_reader(app.clone(), job_id.clone(), "stdout", stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(spawn_stream_reader(app.clone(), job_id.clone(), "stderr", stderr));
        }

        let exit_code = match child.wait() {
            Ok(status) => status.code(),
            Err(error) => {
                emit_shell_event(
                    &app,
                    ShellCommandStreamEvent {
                        job_id: job_id.clone(),
                        stream: "error",
                        chunk: format!("failed while waiting for command: {error}"),
                        done: false,
                        exit_code: None,
                    },
                );
                None
            }
        };

        for reader in readers {
            let _ = reader.join();
        }

        emit_shell_event(
            &app,
            ShellCommandStreamEvent {
                job_id,
                stream: "status",
                chunk: "finished".to_string(),
                done: true,
                exit_code,
            },
        );
    });

    Ok(returned_job_id)
}

#[tauri::command]
fn start_workspace_watch(
    app: AppHandle,
    registry: State<'_, WatchRegistry>,
    path: Option<String>,
) -> Result<String, String> {
    let workspace_root = workspace_root();
    if !workspace_root.is_dir() {
        return Err(format!("workspace root is not available: {}", workspace_root.display()));
    }

    let rel_path = path.unwrap_or_default();
    let watch_path = resolve_under_root(&workspace_root, &rel_path)?;
    if !watch_path.is_dir() {
        return Err("workspace watch path must be a directory".to_string());
    }

    let watch_id = create_watch_id();
    let returned_watch_id = watch_id.clone();
    let event_app = app.clone();
    let event_root = workspace_root.clone();

    let mut watcher = recommended_watcher(move |result: notify::Result<notify::Event>| {
        let event = match result {
            Ok(event) => WorkspaceFileEvent {
                watch_id: watch_id.clone(),
                kind: format!("{:?}", event.kind),
                paths: event
                    .paths
                    .iter()
                    .map(|path| display_relative_path(&event_root, path))
                    .collect(),
            },
            Err(error) => WorkspaceFileEvent {
                watch_id: watch_id.clone(),
                kind: "Error".to_string(),
                paths: vec![error.to_string()],
            },
        };
        let _ = event_app.emit("workspace-file-event", event);
    })
    .map_err(|error| format!("failed to create watcher: {error}"))?;

    watcher
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|error| format!("failed to watch {}: {error}", watch_path.display()))?;

    let mut watchers = registry
        .watchers
        .lock()
        .map_err(|_| "watch registry is unavailable".to_string())?;
    watchers.insert(returned_watch_id.clone(), watcher);

    app.emit(
        "workspace-file-event",
        WorkspaceFileEvent {
            watch_id: returned_watch_id.clone(),
            kind: "Ready".to_string(),
            paths: vec![display_relative_path(&workspace_root, &watch_path)],
        },
    )
    .map_err(|error| format!("failed to emit watch ready event: {error}"))?;

    Ok(returned_watch_id)
}

#[tauri::command]
fn stop_workspace_watch(registry: State<'_, WatchRegistry>, watch_id: String) -> Result<bool, String> {
    let mut watchers = registry
        .watchers
        .lock()
        .map_err(|_| "watch registry is unavailable".to_string())?;
    Ok(watchers.remove(&watch_id).is_some())
}

fn spawn_stream_reader<R: Read + Send + 'static>(
    app: AppHandle,
    job_id: String,
    stream: &'static str,
    source: R,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(source);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => emit_shell_event(
                    &app,
                    ShellCommandStreamEvent {
                        job_id: job_id.clone(),
                        stream,
                        chunk: line.clone(),
                        done: false,
                        exit_code: None,
                    },
                ),
                Err(error) => {
                    emit_shell_event(
                        &app,
                        ShellCommandStreamEvent {
                            job_id: job_id.clone(),
                            stream: "error",
                            chunk: format!("failed reading {stream}: {error}"),
                            done: false,
                            exit_code: None,
                        },
                    );
                    break;
                }
            }
        }
    })
}

fn emit_shell_event(app: &AppHandle, event: ShellCommandStreamEvent) {
    let _ = app.emit("shell-command-output", event);
}

fn create_job_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("shell-{millis}")
}

fn create_watch_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("watch-{millis}")
}

fn home_dir() -> PathBuf {
    env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

fn workspace_root() -> PathBuf {
    env::var("WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join("workspace"))
}

fn resolve_under_root(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel = rel_path.trim().trim_start_matches('/');
    let candidate = root.join(rel).canonicalize().map_err(|error| {
        if rel.is_empty() {
            format!("workspace root is not available: {error}")
        } else {
            format!("workspace path is not available: {error}")
        }
    })?;
    if !candidate.starts_with(root) {
        return Err("path escapes workspace root".to_string());
    }
    Ok(candidate)
}

fn display_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

fn default_workdir() -> PathBuf {
    let configured = env::var("HERMES_WORKDIR")
        .unwrap_or_else(|_| home_dir().join(".hermes").display().to_string());
    let path = PathBuf::from(configured);
    if path.is_dir() {
        return path;
    }
    env::current_dir().unwrap_or_else(|_| Path::new("/").to_path_buf())
}

fn command_is_high_impact(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    [
        "rm ",
        "rm -",
        "sudo ",
        "su ",
        "git push",
        "npm install",
        "npm i",
        "pnpm add",
        "yarn add",
        "cargo install",
        "systemctl",
        "docker ",
        "podman ",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

pub fn run() {
    tauri::Builder::default()
        .manage(WatchRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_desktop_runtime_info,
            get_runtime_config,
            execute_shell_command,
            start_shell_command_stream,
            start_workspace_watch,
            stop_workspace_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}