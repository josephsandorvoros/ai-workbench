import { useEffect, useRef, useState } from "react";
import { prepareAttachment } from "../agent/attachments";
import { fetchAgentSkills, type AgentSkill } from "../agent/agentData";
import { compatClient } from "../api/compatClient";
import { removePlanSubtask, type Plan, type WorkerProfile } from "../agent/jobPlan";
import { Icon } from "./Icon";
import { saveOpenCodeSettings } from "./OpenCodeSettings";

type WorkerAttempt = { attempt: number; status: string; started_at?: number; finished_at?: number; error?: string; project_branch?: string; project_merged_at?: number | null; input_tokens?: number; output_tokens?: number; cost?: number };
type Subtask = { idx: number; title: string; status: string; result?: string; error?: string; depends_on?: number[]; wave?: number; attempts?: WorkerAttempt[] };
type Job = {
  id: string; title: string; description: string; stage: string; detail: string; archived: number;
  project_path?: string | null; base_branch?: string | null;
  token_budget?: number | null; cost_budget?: number | null;
  created_at: number; updated_at: number; questions: string[] | null; answers: string[] | null;
  plan: Plan | null; subtasks: Subtask[]; summary: string | null; error: string | null; attachments: string[]; skills: string[];
  events?: Array<{ ts: number; message: string }>;
};
type UploadedFile = { path: string; name: string; size: number };
type Settings = { plan_gate: boolean; auto_approve: boolean; worker_model: string; max_workers_per_job: number };
type CommsEntry = { ts: number; round: number; question?: string; answer?: string };
type CommsThread = { idx: number; title: string; status: string; rounds: number; pending: string | null; entries: CommsEntry[] };
type WorkerProfileDraft = Omit<WorkerProfile, "created_at" | "updated_at" | "id"> & { id?: string };
type ProjectChanges = { branch: string; base_branch: string; files: string[]; uncommitted: string[]; diff: string; diff_truncated: boolean; working_diff: string; working_diff_truncated: boolean; merged_at: number | null; worker_status: string };

const LANES = ["inbox", "review", "needs_input", "planned", "running", "replanning", "collating", "done", "failed", "stopped"];
const FINISHED = ["done", "failed", "stopped"];
// Mirrors MOVE_TARGETS in jobs_engine.py: where a job may be moved from each stage.
const MOVE_TARGETS: Record<string, string[]> = {
  inbox: [], review: ["inbox"], needs_input: ["inbox"], planned: ["inbox"],
  running: ["inbox", "planned", "running"], replanning: ["inbox", "planned", "running"],
  collating: ["inbox", "planned", "running"],
  done: ["inbox"], failed: ["inbox"], stopped: ["inbox"],
};
const MOVE_LABELS: Record<string, string> = { running: "running (re-run workers)" };

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/jobs${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await response.text();
  let result: { ok?: boolean; message?: string };
  try {
    result = text ? JSON.parse(text) as { ok?: boolean; message?: string } : {};
  } catch {
    throw new Error(`Server returned an invalid response (${response.status})`);
  }
  if (!response.ok || !result.ok) throw new Error(result.message || `Request failed (${response.status})`);
  return result as T;
}

function dateTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString();
}

export function JobsBoard({ active = true, onOpenFiles }: { active?: boolean; onOpenFiles?: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Job | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [availableSkills, setAvailableSkills] = useState<AgentSkill[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [editingPlan, setEditingPlan] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [logIndex, setLogIndex] = useState<number | null>(null);
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [comms, setComms] = useState<CommsThread[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [profiles, setProfiles] = useState<WorkerProfile[]>([]);
  const [showProfiles, setShowProfiles] = useState(false);
  const [profileDraft, setProfileDraft] = useState<WorkerProfileDraft | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileApiKey, setProfileApiKey] = useState("");
  const [profileClearKey, setProfileClearKey] = useState(false);
  const [profileEndpointMode, setProfileEndpointMode] = useState("default");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [projectChanges, setProjectChanges] = useState<Record<number, ProjectChanges>>({});
  const [tokenBudget, setTokenBudget] = useState("");
  const [costBudget, setCostBudget] = useState("");

  async function refreshProfiles() {
    try {
      const response = await fetch("/api/worker-profiles");
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Could not load worker profiles");
      setProfiles(result.profiles || []);
    } catch (failure) {
      setError(String(failure));
    }
  }

  useEffect(() => {
    if (!active) return;
    void fetchAgentSkills().then((result) => setAvailableSkills(result.skills.filter((skill) => skill.source === "hermes"))).catch(() => setAvailableSkills([]));
  }, [active]);

  useEffect(() => {
    if (active) void refreshProfiles();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    async function refresh() {
      try {
        const list = await request<{ jobs: Job[]; settings: Settings }>(showArchived ? "?archived=1" : "");
        if (live) { setJobs(list.jobs); setSettings(list.settings); setError(""); setLoaded(true); }
      } catch (failure) {
        if (live) { setError(String(failure)); setLoaded(true); }
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, showArchived]);

  useEffect(() => {
    if (!active || !selectedId) return;
    let live = true;
    const jobId = selectedId;
    async function refresh() {
      try {
        const detail = await request<{ job: Job }>(`/${encodeURIComponent(jobId)}`);
        if (live) setSelected(detail.job);
      } catch (failure) {
        if (live) setError(String(failure));
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, selectedId]);

  useEffect(() => {
    if (selected?.stage === "needs_input") setAnswers(selected.questions?.map(() => "") || []);
    if (selected?.stage === "planned") setPlan(selected.plan ? structuredClone(selected.plan) : null);
  }, [selected?.id, selected?.stage]);

  useEffect(() => {
    if (!active || !selectedId || logIndex === null) return;
    const jobId = selectedId;
    const stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/subtasks/${logIndex}/stream`);
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { log: string; replace: boolean; status: string };
        setLog((current) => payload.replace ? payload.log : current + payload.log);
        if (!["queued", "running", "waiting_input"].includes(payload.status)) stream.close();
      } catch { setLog(event.data); }
    };
    return () => stream.close();
  }, [active, selectedId, logIndex]);

  useEffect(() => {
    if (!active || !selectedId) return;
    let live = true;
    const jobId = selectedId;
    async function refresh() {
      try {
        const result = await request<{ threads: CommsThread[] }>(`/${encodeURIComponent(jobId)}/comms`);
        if (live) setComms(result.threads || []);
      } catch {
        if (live) setComms([]);
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, selectedId]);

  function openJob(job: Job) {
    setSelectedId(job.id);
    setSelected(job);
    setAnswers(job.questions?.map((_, index) => job.answers?.[index] || "") || []);
    setPlan(job.plan ? structuredClone(job.plan) : null);
    setEditingPlan(false);
    setLogIndex(null);
    setLog("");
    setMoveTarget("");
    setMoveNote("");
    setComms([]);
    setError("");
  }

  async function addFiles(files: File[]) {
    if (attachments.length + files.length > 5 || files.some((file) => file.size > 10 * 1024 * 1024)
      || attachments.reduce((size, file) => size + file.size, 0) + files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) {
      setError("Attach up to five files, 10 MB each and 20 MB total.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      for (const file of files) {
        const uploaded = await prepareAttachment(file, compatClient.uploadFile);
        setAttachments((current) => [...current, { name: uploaded.name, path: uploaded.path, size: uploaded.size }]);
      }
    } catch (failure) {
      setError(String(failure));
    } finally {
      setUploading(false);
    }
  }

  async function perform(path: string, body: object = {}) {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ job?: Job; deleted?: string }>(path, body);
      if (!path) { setCreating(false); setTitle(""); setDescription(""); setAttachments([]); setSelectedSkills([]); setShowAdvanced(false); }
      if (result.deleted) { setSelectedId(null); setSelected(null); }
      else if (result.job) {
        if (result.job.archived && !showArchived) { setSelectedId(null); setSelected(null); }
        else openJob(result.job);
      }
      const list = await request<{ jobs: Job[]; settings: Settings }>(showArchived ? "?archived=1" : "");
      setJobs(list.jobs);
      setSettings(list.settings);
      if (path === "") setSelectedProfileId("");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className={`jobs-board ${selectedId ? "has-detail" : ""}`} aria-label="Jobs board">
    <div className="jobs-main">
      <div className="jobs-toolbar">
        <button className="btn primary small" type="button" onClick={() => setCreating(!creating)}>{creating ? "Cancel" : "New job"}</button>
        <button className="btn secondary small" type="button" onClick={() => { setShowProfiles(!showProfiles); setProfileDraft(null); }}>{showProfiles ? "Close profiles" : "Worker profiles"}</button>
        <label className="jobs-archive-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
        {settings && <span className="jobs-settings" title={`Worker model: ${settings.worker_model}`}>Plan approval {settings.plan_gate ? "on" : "off"} / Auto-approve {settings.auto_approve ? "on" : "off"}</span>}
      </div>
      {showProfiles && <section className="jobs-profile-manager" aria-label="Worker profiles">
        <div className="jobs-section-head"><h3>Worker profiles</h3><button className="btn primary small" type="button" onClick={() => { setProfileApiKey(""); setProfileClearKey(false); setProfileEndpointMode("default"); setProfileDraft({ name: "", instructions: "", runtime: "opencode", model: settings?.worker_model || "opencode/big-pickle", base_url: null, api_key_env: "", skills: [], permission_preset: "guarded" }); }}>New profile</button></div>
        {profileDraft && <form className="jobs-profile-form" onSubmit={async (event) => {
          event.preventDefault();
          setProfileSaving(true); setError("");
          try {
            if (profileApiKey || profileClearKey) {
              if (!profileDraft.api_key_env) throw new Error("A key variable name is required");
              await saveOpenCodeSettings({ keys: { [profileDraft.api_key_env]: profileClearKey ? "" : profileApiKey } });
              setProfileApiKey(""); setProfileClearKey(false);
            }
            const response = await fetch("/api/worker-profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profileDraft) });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.message || "Could not save worker profile");
            setProfileDraft(null); await refreshProfiles();
          } catch (failure) { setError(String(failure)); }
          finally { setProfileSaving(false); }
        }}>
          <label>Name<input required maxLength={80} value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label>
          <label>Role instructions<textarea rows={4} maxLength={8000} value={profileDraft.instructions} onChange={(event) => setProfileDraft({ ...profileDraft, instructions: event.target.value })} /></label>
          <div className="jobs-profile-fields">
            <label>Runtime<select value={profileDraft.runtime} onChange={(event) => setProfileDraft({ ...profileDraft, runtime: event.target.value })}><option value="opencode">OpenCode</option></select></label>
            <label>Model<input required maxLength={200} value={profileDraft.model} onChange={(event) => setProfileDraft({ ...profileDraft, model: event.target.value })} /></label>
            <label>Permissions<select value={profileDraft.permission_preset} onChange={(event) => setProfileDraft({ ...profileDraft, permission_preset: event.target.value as WorkerProfileDraft["permission_preset"] })}><option value="guarded">Guarded</option><option value="trusted">Trusted</option></select></label>
          </div>
          <div className="jobs-profile-fields">
            <label>Endpoint<select value={profileEndpointMode} onChange={(event) => { setProfileEndpointMode(event.target.value); setProfileApiKey(""); setProfileClearKey(false); setProfileDraft({ ...profileDraft, base_url: event.target.value === "default" ? null : "", api_key_env: "" }); }}>
              <option value="default">Worker default</option><option value="provider">OpenCode provider</option><option value="custom">Custom endpoint</option>
            </select></label>
            {profileEndpointMode === "custom" && <label>Endpoint URL<input required type="url" value={profileDraft.base_url || ""} onChange={(event) => setProfileDraft({ ...profileDraft, base_url: event.target.value })} /></label>}
            <label>Key variable<input pattern="WORKER_[A-Z0-9_]*API_KEY" placeholder="WORKER_CODER_API_KEY" value={profileDraft.api_key_env || ""} onChange={(event) => setProfileDraft({ ...profileDraft, api_key_env: event.target.value })} /></label>
          </div>
          <>
            <label>Profile API key<input type="password" autoComplete="new-password" disabled={profileClearKey} value={profileApiKey} onChange={(event) => setProfileApiKey(event.target.value)} /></label>
            <label className="opencode-clear-key"><input type="checkbox" checked={profileClearKey} onChange={(event) => { setProfileClearKey(event.target.checked); setProfileApiKey(""); }} /> Clear key</label>
          </>
          <label>Skills<select value="" disabled={profileDraft.skills.length >= 5} onChange={(event) => { if (event.target.value) setProfileDraft({ ...profileDraft, skills: [...profileDraft.skills, event.target.value] }); }}>
            <option value="">Add a skill</option>{availableSkills.filter((skill) => !profileDraft.skills.includes(skill.path)).map((skill) => <option key={skill.path} value={skill.path}>{skill.name}</option>)}
          </select></label>
          {profileDraft.skills.map((skill) => <div className="jobs-profile-skill" key={skill}><span>{availableSkills.find((item) => item.path === skill)?.name || skill}</span><button className="jobs-close" type="button" aria-label={`Remove ${skill}`} onClick={() => setProfileDraft({ ...profileDraft, skills: profileDraft.skills.filter((item) => item !== skill) })}><Icon name="x" size={14} /></button></div>)}
          <div className="jobs-profile-actions"><button className="btn primary small" type="submit" disabled={profileSaving}>{profileSaving ? "Saving..." : "Save profile"}</button><button className="btn secondary small" type="button" onClick={() => setProfileDraft(null)}>Cancel</button></div>
        </form>}
        <div className="jobs-profile-list">{profiles.map((profile) => <div className="jobs-profile-row" key={profile.id}>
          <div><strong>{profile.name}</strong><span>{profile.runtime} / {profile.model} / {profile.permission_preset} / {profile.base_url == null ? "default endpoint" : profile.base_url || "OpenCode provider"}</span></div>
          <div className="jobs-profile-actions">
            <button className="btn secondary small" type="button" onClick={() => { setProfileApiKey(""); setProfileClearKey(false); setProfileEndpointMode(profile.base_url == null ? "default" : profile.base_url === "" ? "provider" : "custom"); setProfileDraft({ ...profile }); setShowProfiles(true); }}>Edit</button>
            <button className="btn secondary small" type="button" onClick={() => { setSelectedProfileId(profile.id); setCreating(true); setShowProfiles(false); setTitle(profile.name); }}>Launch</button>
            <button className="btn danger small" type="button" onClick={async () => {
              if (!window.confirm(`Delete worker profile "${profile.name}"? Existing jobs keep their snapshots.`)) return;
              const response = await fetch(`/api/worker-profiles/${encodeURIComponent(profile.id)}/delete`, { method: "POST" });
              const result = await response.json();
              if (!response.ok || !result.ok) { setError(result.message || "Could not delete worker profile"); return; }
              await refreshProfiles();
            }}>Delete</button>
          </div>
        </div>)}</div>
      </section>}
      {creating && <form className="jobs-create" onSubmit={(event) => { event.preventDefault(); if (!busy && !uploading) void perform("", { title, description, attachments: attachments.map((file) => file.path), skills: selectedSkills, profile_id: selectedProfileId || null, project_path: projectPath.trim() || null, base_branch: baseBranch.trim() || "", token_budget: tokenBudget ? Number(tokenBudget) : null, cost_budget: costBudget ? Number(costBudget) : null }); }}>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required /></label>
        <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={20000} /></label>
        <label>Default worker profile<select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="">Use board defaults</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
        <div className="jobs-budget-fields"><label>Token budget<input type="number" min="1" step="1" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} placeholder="No cap" /></label><label>Spend budget (USD)<input type="number" min="0.01" step="0.01" value={costBudget} onChange={(event) => setCostBudget(event.target.value)} placeholder="No cap" /></label></div>
        <p className="jobs-budget-note">Budgets stop queued workers after completed usage crosses the cap. Workers already running can finish.</p>
        <details className="jobs-project-options"><summary>Project repository (optional)</summary>
          <label>Workspace path<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="projects/my-app" /></label>
          <label>Base branch<input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="Current branch" /></label>
        </details>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
          <button className="btn secondary small" type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}><Icon name="upload" size={14} /> Attach files</button>
          {attachments.length > 0 && <ul className="jobs-files">{attachments.map((file) => <li key={file.path}>
            <span>{file.name} ({file.size} bytes)</span>
            <button type="button" className="jobs-close" aria-label={`Remove ${file.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}><Icon name="x" size={14} /></button>
          </li>)}</ul>}
          <div className="jobs-advanced">
            <button type="button" className="jobs-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>{showAdvanced ? "Hide advanced" : "Show advanced (optional)"}</button>
            {showAdvanced && <>
              <label>Worker skills (optional)
                <select value="" disabled={selectedSkills.length >= 5} onChange={(event) => { if (event.target.value) setSelectedSkills((current) => [...current, event.target.value]); }}>
                  <option value="">Select a skill</option>
                  {availableSkills.filter((skill) => !selectedSkills.includes(skill.path)).map((skill) => <option key={skill.path} value={skill.path}>{skill.name}</option>)}
                </select>
              </label>
              {selectedSkills.length > 0 && <ul className="jobs-files">{selectedSkills.map((path) => <li key={path}>
                <span>{availableSkills.find((skill) => skill.path === path)?.name || path}</span>
                <button type="button" className="jobs-close" aria-label={`Remove ${path}`} onClick={() => setSelectedSkills((current) => current.filter((item) => item !== path))}><Icon name="x" size={14} /></button>
              </li>)}</ul>}
            </>}
          </div>
          <button className="btn primary small" type="submit" disabled={busy || uploading || !title.trim()}>{uploading ? "Uploading..." : "Create job"}</button>
      </form>}
      {error && <p className="jobs-error" role="alert">{error}</p>}
      <div className="jobs-lanes">
        {[...LANES, ...(showArchived ? ["archived"] : [])].map((lane) => {
          const laneJobs = jobs.filter((job) => lane === "archived" ? job.archived : !job.archived && job.stage === lane);
          return <section className="jobs-lane" key={lane} aria-label={`${lane.replace("_", " ")} jobs`}>
            <h3>{lane.replace("_", " ")} <span>{laneJobs.length}</span></h3>
            <div className="jobs-lane-list">
              {laneJobs.map((job) => <button className={`jobs-card ${selectedId === job.id ? "selected" : ""}`} type="button" key={job.id} onClick={() => openJob(job)}>
                <strong>{job.title}</strong><span>{job.detail}</span>
                {job.subtasks.length > 0 && <small>{job.subtasks.filter((subtask) => subtask.status === "done").length}/{job.subtasks.length} workers done</small>}
                <time dateTime={new Date(job.created_at * 1000).toISOString()}>{dateTime(job.created_at)}</time>
              </button>)}
              {laneJobs.length === 0 && <p className="jobs-empty">No jobs</p>}
            </div>
          </section>;
        })}
      </div>
      {!loaded && <p className="jobs-loading">Loading jobs...</p>}
    </div>
    {selectedId && <aside className="jobs-detail" aria-label="Job details">
      <div className="jobs-detail-head"><div><span className="jobs-stage">{selected?.stage.replace("_", " ") || "Loading"}</span><h3>{selected?.title || "Job"}</h3></div>
        <button className="jobs-close" type="button" title="Close details" aria-label="Close details" onClick={() => { setSelectedId(null); setSelected(null); }}><Icon name="x" /></button>
      </div>
      {selected && <div className="jobs-detail-body">
        <p className="jobs-detail-meta">Created {dateTime(selected.created_at)} / Updated {dateTime(selected.updated_at)}</p>
        {MOVE_TARGETS[selected.stage]?.length > 0 && !selected.archived && <section>
          <h4>Move job</h4>
          <p className="jobs-detail-meta">Send it back to another stage for clarification or a re-run.</p>
          <div className="jobs-move">
            <select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
              <option value="">Choose a stage…</option>
              {MOVE_TARGETS[selected.stage].map((target) => <option key={target} value={target}>{MOVE_LABELS[target] || target.replace("_", " ")}</option>)}
            </select>
            <input value={moveNote} onChange={(event) => setMoveNote(event.target.value)} placeholder="Note (optional)" maxLength={500} />
            <button className="btn secondary small" type="button" disabled={busy || !moveTarget}
              onClick={() => { if (window.confirm(`Move "${selected.title}" to ${MOVE_LABELS[moveTarget] || moveTarget.replace("_", " ")}?`)) void perform(`/${selected.id}/move`, { stage: moveTarget, note: moveNote }); }}>
              Move
            </button>
          </div>
        </section>}
        {selected.description && <section><h4>Request</h4><p className="jobs-text">{selected.description}</p></section>}
        {(selected.project_path || selected.token_budget || selected.cost_budget) && <section><h4>Execution</h4>
          {selected.project_path && <p className="jobs-text">{selected.project_path} · base {selected.base_branch}</p>}
          {(selected.token_budget || selected.cost_budget) && <p className="jobs-text">{selected.token_budget ? `${selected.token_budget.toLocaleString()} tokens` : "No token cap"} · {selected.cost_budget ? `$${selected.cost_budget.toFixed(2)} spend cap` : "No spend cap"}</p>}
        </section>}
        {selected.attachments?.length > 0 && <section><h4>Attached files</h4><ul className="jobs-files">{selected.attachments.map((name) => <li key={name}>{name}</li>)}</ul></section>}
        {selected.skills?.length > 0 && <section><h4>Worker skills</h4><ul className="jobs-files">{selected.skills.map((name) => <li key={name}>{name}</li>)}</ul></section>}
        {selected.error && <p className="jobs-error" role="alert">{selected.error}</p>}
        {selected.stage === "needs_input" && selected.questions && <form onSubmit={(event) => { event.preventDefault(); void perform(`/${selected.id}/answer`, { answers }); }}>
          <h4>Questions from Hermes</h4>
          {selected.questions.map((question, index) => <label className="jobs-question" key={index}>{question}
            <textarea required value={answers[index] || ""} onChange={(event) => setAnswers((current) => current.map((value, answerIndex) => answerIndex === index ? event.target.value : value))} rows={2} />
          </label>)}
          <button className="btn primary small" type="submit" disabled={busy || answers.some((answer) => !answer.trim())}>Send answers</button>
        </form>}
        {selected.plan && <section><div className="jobs-section-head"><h4>Plan</h4>
          {selected.stage === "planned" && <button className="btn secondary small" type="button" onClick={() => { setEditingPlan(!editingPlan); setPlan(structuredClone(selected.plan)); }}>{editingPlan ? "Discard edits" : "Edit plan"}</button>}
        </div>
          {editingPlan && plan ? <div className="jobs-plan-edit"><label>Summary<input value={plan.summary} onChange={(event) => setPlan({ ...plan, summary: event.target.value })} /></label>
            {plan.subtasks.map((subtask, index) => <div className="jobs-plan-task" key={index}>
              <label>Worker {index + 1} title<input value={subtask.title} onChange={(event) => setPlan({ ...plan, subtasks: plan.subtasks.map((item, taskIndex) => taskIndex === index ? { ...item, title: event.target.value } : item) })} /></label>
              <label>Instructions<textarea rows={3} value={subtask.instructions} onChange={(event) => setPlan({ ...plan, subtasks: plan.subtasks.map((item, taskIndex) => taskIndex === index ? { ...item, instructions: event.target.value } : item) })} /></label>
              <label>Worker profile<select value={subtask.profile_id || ""} onChange={(event) => setPlan({ ...plan, subtasks: plan.subtasks.map((item, taskIndex) => taskIndex === index ? { ...item, profile_id: event.target.value || null } : item) })}><option value="">Job default</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
              <button className="btn secondary small" type="button" onClick={() => {
                const dependents = plan.subtasks.filter((item, taskIndex) => taskIndex !== index && item.depends_on?.includes(index));
                if (dependents.length && !window.confirm(`Remove worker ${index + 1}? ${dependents.length} worker(s) depend on it; those dependency links will be removed.`)) return;
                setPlan((current) => current ? removePlanSubtask(current, index) : current);
              }}>Remove worker</button>
            </div>)}
            <button className="btn secondary small" type="button" disabled={plan.subtasks.length >= (settings?.max_workers_per_job || 3)} onClick={() => setPlan({ ...plan, subtasks: [...plan.subtasks, { title: "", instructions: "" }] })}>Add worker</button>
          </div> : <><p className="jobs-text">{selected.plan.summary}</p><ol className="jobs-plan-list">{selected.plan.subtasks.map((subtask, index) => <li key={index}><strong>{subtask.title}</strong>{(subtask.depends_on?.length ?? 0) > 0 && <span className="jobs-deps"> after {subtask.depends_on!.map((d) => d + 1).join(", ")}</span>}<p className="jobs-text">{subtask.instructions}</p></li>)}</ol></>}
          {selected.stage === "planned" && <button className="btn primary small" type="button" disabled={busy || !!(editingPlan && (!plan?.subtasks.length || plan.subtasks.some((subtask) => !subtask.instructions.trim())))} onClick={() => void perform(`/${selected.id}/approve`, editingPlan ? { plan } : {})}>Approve plan</button>}
        </section>}
        {selected.subtasks.length > 0 && <section><h4>Workers</h4>{selected.subtasks.map((subtask) => <div className="jobs-worker" key={subtask.idx}>
          <div className="jobs-section-head"><strong>{subtask.idx + 1}. {subtask.title}</strong>{(subtask.wave ?? 0) > 0 && <span className="jobs-wave">wave {subtask.wave}</span>}{(subtask.depends_on?.length ?? 0) > 0 && <span className="jobs-deps"> after {subtask.depends_on!.map((d) => d + 1).join(", ")}</span>}<span className="jobs-stage">{subtask.status}</span></div>
          {subtask.error && <p className="jobs-error">{subtask.error}</p>}
          {subtask.result && <pre className="jobs-output">{subtask.result}</pre>}
          {subtask.attempts && subtask.attempts.length > 0 && <div className="jobs-attempts" aria-label={`Worker ${subtask.idx + 1} attempt history`}>
            {subtask.attempts.map((attempt) => <span key={attempt.attempt}>Attempt {attempt.attempt}: {attempt.status} · {(attempt.input_tokens || 0) + (attempt.output_tokens || 0)} tokens · ${(attempt.cost || 0).toFixed(4)}{attempt.project_branch ? ` · ${attempt.project_branch}` : ""}{attempt.error ? ` · ${attempt.error}` : ""}</span>)}
          </div>}
          {selected.project_path && subtask.attempts?.some((attempt) => attempt.project_branch) && <div className="jobs-project-actions">
            <button className="btn secondary small" type="button" onClick={async () => {
              try {
                const result = await request<{ changes: ProjectChanges }>(`/${selected.id}/subtasks/${subtask.idx}/project`);
                setProjectChanges((current) => ({ ...current, [subtask.idx]: result.changes }));
              } catch (failure) { setError(String(failure)); }
            }}>Inspect changes</button>
            {selected.stage === "done" && subtask.status === "done" && !subtask.attempts[subtask.attempts.length - 1].project_merged_at && <button className="btn primary small" type="button" disabled={busy} onClick={() => {
              if (window.confirm(`Merge ${subtask.attempts?.[subtask.attempts.length - 1].project_branch} into ${selected.base_branch}?`)) void perform(`/${selected.id}/subtasks/${subtask.idx}/merge`);
            }}>Merge to base</button>}
          </div>}
          {projectChanges[subtask.idx] && <div className="jobs-project-diff"><strong>{projectChanges[subtask.idx].branch} → {projectChanges[subtask.idx].base_branch}</strong>
            {projectChanges[subtask.idx].files.length ? <ul>{projectChanges[subtask.idx].files.map((file) => <li key={file}>{file}</li>)}</ul> : <span>No committed changes</span>}
            {projectChanges[subtask.idx].diff && <><h5>Committed patch</h5><pre className="jobs-project-patch">{projectChanges[subtask.idx].diff}</pre>{projectChanges[subtask.idx].diff_truncated && <span>Committed patch truncated at 100 KB.</span>}</>}
            {projectChanges[subtask.idx].uncommitted.length > 0 && <><p className="jobs-error">Uncommitted worker changes: {projectChanges[subtask.idx].uncommitted.join(", ")}</p>{projectChanges[subtask.idx].working_diff && <><h5>Uncommitted tracked patch</h5><pre className="jobs-project-patch">{projectChanges[subtask.idx].working_diff}</pre>{projectChanges[subtask.idx].working_diff_truncated && <span>Working patch truncated at 100 KB.</span>}</>}</>}
          </div>}
          <button className="btn secondary small" type="button" onClick={() => { setLog(""); setLogIndex(logIndex === subtask.idx ? null : subtask.idx); }}>{logIndex === subtask.idx ? "Hide log" : "View log"}</button>
          {logIndex === subtask.idx && <pre className="jobs-output" aria-label={`Worker ${subtask.idx + 1} log`}>{log || "No log yet"}</pre>}
          {FINISHED.includes(selected.stage) && ["failed", "timeout"].includes(subtask.status) && <button className="btn secondary small" type="button" disabled={busy} onClick={() => void perform(`/${selected.id}/subtasks/${subtask.idx}/retry`)}>Retry worker</button>}
        </div>)}</section>}
        {comms.length > 0 && <section><h4>Clarifications</h4>
          {comms.map((thread) => <div className="jobs-comms-thread" key={thread.idx}>
            <div className="jobs-section-head"><strong>Worker {thread.idx + 1} · {thread.title}</strong><span className="jobs-stage">{thread.status}</span></div>
            {thread.entries.map((entry, index) => <div className="jobs-comms" key={index}>
              {entry.question && <p className="jobs-comms-q"><span>Worker asked</span>{entry.question}</p>}
              {entry.answer && <p className="jobs-comms-a"><span>Coordinator</span>{entry.answer}</p>}
            </div>)}
            {thread.pending && <p className="jobs-comms-pending"><span>Waiting on coordinator</span>{thread.pending}</p>}
          </div>)}
        </section>}
        {selected.summary && <section><h4>Final summary</h4><p className="jobs-text">{selected.summary}</p></section>}
        {selected.subtasks.length > 0 && <button className="btn secondary small" type="button" onClick={() => onOpenFiles?.(selected.id)}>Open files in Projects</button>}
        {selected.events && <section><h4>Timeline</h4><ol className="jobs-timeline">{selected.events.map((event, index) => <li key={index}><time>{dateTime(event.ts)}</time><span>{event.message}</span></li>)}</ol></section>}
        <div className="jobs-actions">
          {!FINISHED.includes(selected.stage) && <button className="btn danger small" type="button" disabled={busy} onClick={() => void perform(`/${selected.id}/stop`)}>Stop job</button>}
          {FINISHED.includes(selected.stage) && !selected.archived && <>
            <button className="btn secondary small" type="button" disabled={busy} onClick={() => void perform(`/${selected.id}/retry`)}>Retry</button>
            <button className="btn danger small" type="button" disabled={busy} onClick={() => { if (window.confirm(`Archive ${selected.title}?`)) void perform(`/${selected.id}/archive`); }}>Archive</button>
          </>}
          {FINISHED.includes(selected.stage) && <button className="btn danger small" type="button" disabled={busy} onClick={() => { if (window.confirm(`Delete "${selected.title}" and all of its files? This cannot be undone.`)) void perform(`/${selected.id}/delete`); }}>Delete</button>}
        </div>
      </div>}
    </aside>}
  </section>;
}