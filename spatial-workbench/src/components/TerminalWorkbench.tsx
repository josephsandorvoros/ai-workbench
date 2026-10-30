import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { useAgentProvider, updateAgentProvider } from "../agent/agentStore";
import { compatClient, type ComponentUpdate, type SandboxStatus, type UpdatesStatus } from "../api/compatClient";
import { Icon } from "./Icon";

const POLL_MS = 200;

type ShellMode = "cli" | "tui";

async function terminalFetch(path: string, token: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Terminal-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `${path} failed with ${response.status}`);
  }
  return payload;
}

const COMPONENT_LABELS: Record<"workbench" | "opencode", string> = {
  workbench: "Workbench image",
  opencode: "OpenCode",
};

function UpdateRow({ id, info, onRun, canRun = true }: { id: keyof typeof COMPONENT_LABELS; info?: ComponentUpdate | null; onRun: (cmd: string) => void; canRun?: boolean }) {
  if (!info) return null;
  const status = info.error
    ? "check failed"
    : info.update_available
      ? `${info.latest} available`
      : info.latest
        ? "up to date"
        : "unknown";
  return (
    <div className={`update-row ${info.update_available ? "has-update" : ""}`} title={info.error}>
      <span className="update-row-name">{COMPONENT_LABELS[id]}</span>
      <span className="update-row-version">{info.current ?? "?"}</span>
      <span className="update-row-status update-row-guidance"><span>{status}</span><span className="update-row-hint">{id === "opencode" ? "Use the Update button" : "Re-pull and redeploy"}</span></span>
      <span className="update-row-action">{id === "opencode" ? (
        <button className="btn primary small" type="button" disabled={!canRun || !info.update_available || info.action !== "in-place"} onClick={() => {
          if (window.confirm("Update OpenCode? Finish active OpenCode sessions and jobs first.")) onRun("if command -v workbench-update >/dev/null; then workbench-update opencode; else opencode upgrade; fi");
        }}>
          Update
        </button>
      ) : null}</span>
    </div>
  );
}

type HermesRuntime = {
  supported: boolean;
  operation: { state: string; step: string };
};

function HermesUpdateRow({ info, active, token, onRefreshUpdates }: {
  info: ComponentUpdate;
  active: boolean;
  token: string;
  onRefreshUpdates: () => void;
}) {
  const [runtime, setRuntime] = useState<HermesRuntime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previousState = useRef("");
  const refreshRef = useRef(onRefreshUpdates);
  refreshRef.current = onRefreshUpdates;

  useEffect(() => {
    if (!active) return;
    let live = true;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const result = await terminalFetch("/api/hermes-runtime", token) as HermesRuntime;
        if (!live) return;
        setRuntime(result);
        if (previousState.current === "running" && result.operation.state !== "running") refreshRef.current();
        previousState.current = result.operation.state;
      } catch (failure) {
        if (live) { setRuntime(null); setError(String(failure)); }
      } finally { polling = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, token]);

  async function operate() {
    const description = `Update Hermes to ${info.tag || info.latest}`;
    if (!window.confirm(`${description}? Active Hermes chats, jobs, and messaging integrations may be interrupted.`)) return;
    setBusy(true); setError("");
    try {
      const result = await terminalFetch("/api/hermes-runtime", token, { action: "update", version: info.tag, confirm: true }) as HermesRuntime;
      setRuntime(result);
      previousState.current = result.operation.state;
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  const running = runtime?.operation.state === "running";
  const disabled = busy || running || !runtime?.supported;
  const updateUnavailable = runtime && !runtime.supported ? "Runtime updates require the managed Workbench agent image" : !info.tag ? "Use Check now to retrieve the release tag" : `Update Hermes to ${info.tag}`;
  const operation = runtime?.operation;
  const recovered = operation?.state === "recovered";
  const status = error || (operation?.step && operation.state !== "idle" && !recovered ? operation.step : info.error ? "check failed" : info.update_available ? `${info.latest} available` : info.latest ? "up to date" : "unknown");
  return <div className={`update-row ${info.update_available ? "has-update" : ""}`} title={error || info.error}>
    <span className="update-row-name">Hermes Agent</span>
    <span className="update-row-version">{info.current ?? "?"}</span>
    <span className="update-row-status update-row-guidance" role={error || operation?.state === "failed" ? "alert" : "status"}>
      <span>{status}</span>
      <span className="update-row-hint">Use the Update button</span>
    </span>
    <span className="update-row-action">
      <button className="btn primary small" type="button" disabled={disabled || !info.update_available || !info.tag} onClick={() => void operate()} title={updateUnavailable}>Update</button>
    </span>
  </div>;
}

export function TerminalWorkbench({ active, updates, onRefreshUpdates }: {
  active: boolean;
  updates: UpdatesStatus | null;
  onRefreshUpdates: () => void;
}) {
  const provider = useAgentProvider();
  const [tokenRequired, setTokenRequired] = useState(true);
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  useEffect(() => {
    compatClient
      .getConfig()
      .then((config) => setTokenRequired(config.terminal_auth_required))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!active) return;
    compatClient.getSandboxStatus().then(setSandbox).catch(() => undefined);
  }, [active]);
  const token = provider.terminalToken;
  const canConnect = Boolean(token) || !tokenRequired;
  const [tokenDraft, setTokenDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  // Keep the latest token reachable from xterm callbacks without re-subscribing.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const getToken = () => tokenRef.current;

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#0b0c0f", foreground: "#e5e7eb", cursor: "#a78bfa" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    term.onData((data) => {
      const sid = sessionRef.current;
      if (sid) void terminalFetch("/api/terminal/input", getToken(), { session_id: sid, data }).catch(() => undefined);
    });
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    if (!term || !fitRef.current || !hostRef.current?.offsetParent) return;
    fitRef.current.fit();
    const sid = sessionRef.current;
    if (sid) {
      void terminalFetch("/api/terminal/resize", getToken(), { session_id: sid, cols: term.cols, rows: term.rows }).catch(
        () => undefined,
      );
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(fitAndResize);
    window.addEventListener("resize", fitAndResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitAndResize);
    };
  }, [active, fitAndResize]);

  // Poll output for the current session.
  useEffect(() => {
    if (!sessionId) return;
    let offset = 0;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const payload = await terminalFetch(
          `/api/terminal/output?session_id=${encodeURIComponent(sessionId)}&offset=${offset}`,
          token,
        );
        if (payload.data) termRef.current?.write(payload.data);
        offset = payload.next_offset ?? offset;
        if (!payload.running) {
          setStatus(`Session ended (exit ${payload.exit_code ?? "?"})`);
          setSessionId(null);
          sessionRef.current = null;
          return;
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
        setSessionId(null);
        sessionRef.current = null;
        return;
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, token]);

  const startSession = useCallback(
    async (mode: ShellMode, initialCommand?: string) => {
      const term = termRef.current;
      if (!term || !canConnect) return;
      fitRef.current?.fit();
      if (sessionRef.current) {
        await terminalFetch("/api/terminal/close", token, { session_id: sessionRef.current }).catch(() => undefined);
      }
      term.reset();
      setStatus("");
      try {
        const payload = await terminalFetch("/api/terminal/start", token, { mode, cols: term.cols, rows: term.rows });
        sessionRef.current = payload.session_id;
        setSessionId(payload.session_id);
        term.focus();
        if (initialCommand) {
          window.setTimeout(() => {
            void terminalFetch("/api/terminal/input", token, { session_id: payload.session_id, data: `${initialCommand}\r` });
          }, 400);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [token, canConnect],
  );

  const runCommand = useCallback(
    (command: string) => {
      const sid = sessionRef.current;
      if (sid) {
        void terminalFetch("/api/terminal/input", token, { session_id: sid, data: `${command}\r` });
        termRef.current?.focus();
      } else {
        void startSession("cli", command);
      }
    },
    [startSession, token],
  );

  const stopSession = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    await terminalFetch("/api/terminal/close", token, { session_id: sid }).catch(() => undefined);
    sessionRef.current = null;
    setSessionId(null);
    setStatus("Session closed");
  }, [token]);

  return (
    <section className="terminal-workbench">
      <div className="terminal-toolbar">
        <button className="btn primary small" type="button" disabled={!canConnect} onClick={() => void startSession("cli")}>
          New shell
        </button>
        <button className="btn secondary small" type="button" disabled={!canConnect} onClick={() => void startSession("tui")}>
          Hermes TUI
        </button>
        <button className="btn secondary small" type="button" disabled={!canConnect} onClick={() => runCommand("opencode")}>
          OpenCode
        </button>
        {sandbox?.enabled ? (
          <button
            className="btn secondary small"
            type="button"
            disabled={!canConnect}
            title="List worker containers on the sandbox daemon"
            onClick={() => runCommand("docker ps -a && docker system df")}
          >
            Sandbox
          </button>
        ) : null}
        <button className="btn danger small" type="button" disabled={!sessionId} onClick={() => void stopSession()}>
          Close
        </button>
        <span className="terminal-status muted">{sessionId ? "Connected" : status || "Not connected"}</span>
      </div>

      {!canConnect ? (
        <form
          className="terminal-token-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (tokenDraft.trim()) updateAgentProvider({ terminalToken: tokenDraft.trim() });
          }}
        >
          <span className="muted">
            Enter the terminal token (<code className="md-inline-code">TERMINAL_API_TOKEN</code>). It is kept for this
            browser session only. Behind an authenticating reverse proxy, set{" "}
            <code className="md-inline-code">WORKBENCH_AUTH=proxy</code> to skip it.
          </span>
          <input
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder="Terminal token"
            aria-label="Terminal token"
          />
          <button className="btn primary small" type="submit">
            Save
          </button>
        </form>
      ) : null}

      <div className="terminal-host" ref={hostRef} />

      {updates?.enabled ? (
        <div className="terminal-updates">
          <div className="terminal-updates-head">
            <strong>Versions</strong>
            <button className="btn secondary small" type="button" onClick={onRefreshUpdates}>
              Check now
            </button>
          </div>
          <UpdateRow id="workbench" info={updates.workbench} onRun={runCommand} />
          {updates.hermes && <HermesUpdateRow info={updates.hermes} active={active} token={token} onRefreshUpdates={onRefreshUpdates} />}
          <UpdateRow id="opencode" info={updates.opencode} canRun={canConnect} onRun={(command) => { void startSession("cli", command); }} />
          {sandbox?.enabled ? (
            <div className={`update-row ${sandbox.reachable ? "" : "has-update"}`} title={sandbox.error}>
              <span className="update-row-name">Sandbox</span>
              <span className="update-row-version">{sandbox.server_version ?? "?"}</span>
              <span className="update-row-status update-row-guidance">
                <span>{sandbox.reachable
                  ? `${sandbox.running ?? 0} running / ${sandbox.containers ?? 0} workers, ${sandbox.images ?? 0} images`
                  : "daemon unreachable"}</span>
                <span className="update-row-hint">Re-pull and redeploy</span>
              </span>
              <span className="update-row-action" />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function countUpdates(updates: UpdatesStatus | null): number {
  if (!updates?.enabled) return 0;
  return [updates.workbench, updates.hermes, updates.opencode].filter((item) => item?.update_available).length;
}

export function loadUpdates(refresh = false) {
  return compatClient.getUpdates(refresh);
}
