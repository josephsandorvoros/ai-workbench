export interface DesktopRuntimeInfo {
  app_name: string;
  runtime: string;
  shell_available: boolean;
}

export interface RuntimeConfig {
  hermes_cli_path: string;
  hermes_workdir: string;
  hermes_endpoint_url: string | null;
  terminal_idle_ttl_seconds: number;
}

export interface ShellCommandRequest {
  command: string;
  cwd?: string;
}

export interface ShellCommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface ShellCommandStreamEvent {
  job_id: string;
  stream: "stdout" | "stderr" | "status" | "error";
  chunk: string;
  done: boolean;
  exit_code: number | null;
}

export interface WorkspaceFileEvent {
  watch_id: string;
  kind: string;
  paths: string[];
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in (globalThis as Record<string, unknown>);
}

export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopRuntimeInfo>("get_desktop_runtime_info");
}

export async function getRuntimeConfig(): Promise<RuntimeConfig | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<RuntimeConfig>("get_runtime_config");
}

export async function executeShellCommand(request: ShellCommandRequest): Promise<ShellCommandResult | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ShellCommandResult>("execute_shell_command", { request });
}

export async function startShellCommandStream(request: ShellCommandRequest): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("start_shell_command_stream", { request });
}

export async function subscribeShellCommandOutput(
  callback: (event: ShellCommandStreamEvent) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<ShellCommandStreamEvent>("shell-command-output", (event) => {
    callback(event.payload);
  });
}

export async function startWorkspaceWatch(path = ""): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("start_workspace_watch", { path });
}

export async function stopWorkspaceWatch(watchId: string): Promise<boolean | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("stop_workspace_watch", { watchId });
}

export async function subscribeWorkspaceFileEvents(
  callback: (event: WorkspaceFileEvent) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<WorkspaceFileEvent>("workspace-file-event", (event) => {
    callback(event.payload);
  });
}