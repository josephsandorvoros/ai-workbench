import { useEffect, useRef, useState } from "react";

import { HermesClient, type HermesContextUsage } from "../agent/hermesClient";
import { endpointFor, loadProviderProfiles, providerLabel, resolveCliPath, runCliTurn } from "../agent/providers";
import {
  PROVIDER_SETTINGS_READY_EVENT,
  applyProviderProfile,
  useAgentProvider,
  updateAgentProvider,
} from "../agent/agentStore";
import { fetchAgentSkills, fetchModelContext, type AgentSkill } from "../agent/agentData";
import {
  compressConversation,
  estimateTokens,
  formatTokenCount,
  shouldCompress,
} from "../agent/contextBudget";
import {
  BUILTIN_SLASH_ITEMS,
  buildHelpText,
  buildSkillPrompt,
  buildSkillPromptHeader,
  filterSlashItems,
  parseGatewaySlashCommand,
  parseSlashQuery,
  type SlashItem,
} from "../agent/slashMenu";
import type { ChatMessage as ChatMlMessage } from "../agent/chatml";
import { fetchSharedHermesContext } from "../agent/sharedContext";
import { LOCAL_VISUAL_TOOLS } from "../agent/boardTools";
import { executeTool } from "../agent/toolExecutor";
import { compatClient } from "../api/compatClient";
import { followHermesTurn, hermesLive } from "../api/hermesLiveClient";
import { fetchSpeechVoices, synthesizeSpeech, transcribeSpeech } from "../api/speechClient";
import { MAX_SPEECH_RECORDING_BYTES, recordingMimeType, textForSpeech, type SpeechVoice } from "../agent/speech";
import { buildAttachmentPrompt, prepareAttachment, type ChatAttachment } from "../agent/attachments";
import { loadRemoteWorkbenchState, saveRemoteWorkbenchField } from "../agent/workbenchRemote";
import {
  CHAT_SESSIONS_CHANGED_EVENT,
  CHAT_SESSIONS_STORAGE_KEY,
  LOAD_CHAT_SESSION_EVENT,
  loadSavedChatSessions,
  type ContextChip,
  type SavedChatMessage,
  type SavedChatSession,
  type ToolCallRecord,
} from "../agent/chatSessions";
import {
  applyMentionToInput,
  buildContextPrompt,
  buildFollowUps,
  filterMentionItems,
  isMutatingTool,
  parseContextChips,
  parseMentionQuery,
  summarizeToolCall,
  truncateOutput,
  type MentionItem,
} from "../agent/toolCallSummary";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";
import { MentionMenu } from "./MentionMenu";
import { ModelPicker, ModePicker } from "./ChatPickers";
import { Icon, type IconName } from "./Icon";

type ChatMessage = SavedChatMessage;

const CHIP_ICONS: Record<ContextChip["kind"], IconName> = {
  board: "board",
  file: "file",
  web: "globe",
  note: "note",
  upload: "file",
  image: "image",
};

function chipIcon(kind: ContextChip["kind"]): IconName {
  return CHIP_ICONS[kind] ?? "note";
}

const CHAT_SESSION_STORAGE_KEY = "homelabSpatialWorkbench.agentChatSession.v1";
const ACTIVE_CHAT_SESSION_KEY = "homelabSpatialWorkbench.activeChatSession.v1";
const ACTIVE_HERMES_RUNS_KEY = "homelabSpatialWorkbench.activeHermesRuns.v1";
const SPEECH_REPLIES_STORAGE_KEY = "homelabSpatialWorkbench.speechReplies.v1";
const SPEECH_VOICE_STORAGE_KEY = "homelabSpatialWorkbench.speechVoice.v1";
const MAX_SPEECH_RECORDING_MS = 60_000;

interface ActiveHermesRun {
  runId: string;
  assistantId: string;
  userId: string;
  userText: string;
}

function loadActiveHermesRuns(): Record<string, ActiveHermesRun> {
  try {
    const runs = JSON.parse(window.localStorage.getItem(ACTIVE_HERMES_RUNS_KEY) || "{}");
    return runs && typeof runs === "object" && !Array.isArray(runs) ? runs as Record<string, ActiveHermesRun> : {};
  } catch {
    return {};
  }
}

function saveActiveHermesRun(sessionId: string, run: ActiveHermesRun | null) {
  const runs = loadActiveHermesRuns();
  if (run) runs[sessionId] = run;
  else delete runs[sessionId];
  window.localStorage.setItem(ACTIVE_HERMES_RUNS_KEY, JSON.stringify(runs));
}

function loadSessionMessages(): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (message) =>
        message &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant" || message.role === "system") &&
        typeof message.content === "string" &&
        typeof message.timestamp === "number",
    );
  } catch (_error) {
    return [];
  }
}

function createChatSessionId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface AgentChatProps {
  /** Optional override for the provider label (defaults to the live shared provider). */
  labelOverride?: string;
}

function formatTime(timestamp: number) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Build a self-contained prompt for CLI harnesses (Hermes / OpenCode),
 * which run one-shot and do not keep conversation state.
 * No persona is injected here — the harness (e.g. Hermes) supplies its own
 * system prompt; we only pass the conversation history and the request.
 */
function buildCliPrompt(history: ChatMessage[], userText: string): string {
  const parts: string[] = [];
  const recent = history
    .filter((message) => message.role !== "system")
    .slice(-8)
    .map((message) => `${message.role === "user" ? "user" : "assistant"}: ${message.content}`)
    .join("\n");
  if (recent) {
    parts.push(`Conversation so far:\n${recent}`);
  }
  parts.push(`Current request:\n${userText}`);
  return parts.join("\n\n");
}

function extractLegacyBashCalls(text: string): string[] {
  const commands: string[] = [];
  const pattern = /<function=Bash>[\s\S]*?<parameter=command>\s*([\s\S]*?)\s*<\/parameter>[\s\S]*?<\/function>/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]?.trim()) commands.push(match[1].trim());
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Chat slash commands — typed in the chat input, handled locally (no model).
// ---------------------------------------------------------------------------

const SLASH_MENU_MAX_ITEMS = 12;

/** @-mention context items (VS Code style): board, files, web, notes. */
const MENTION_ITEMS: MentionItem[] = [
  { kind: "upload", label: "upload", description: "Upload files or images from this computer" },
  { kind: "board", label: "board", description: "Attach the current Spatial Board layout" },
  { kind: "file", label: "file", description: "Attach a file — type its path after @file" },
  { kind: "web", label: "web", description: "Attach a web page — type its URL after @web" },
  { kind: "note", label: "note", description: "Attach a note for the agent to remember" },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch (_fallbackError) {
      return false;
    }
  }
}

/** Pretty-print tool arguments for the card's collapsed "Arguments" section. */
function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch (_error) {
    return String(args);
  }
}

/**
 * Build the full slash menu: built-in commands first, then the agent's
 * skills (/skill:<name>), saved provider profiles (/profile:<name>), and
 * models from the active API endpoint (/model:<name>).
 */
function buildSlashItems(
  skills: AgentSkill[],
  profiles: { name: string }[],
  models: string[],
): SlashItem[] {
  const items: SlashItem[] = [...BUILTIN_SLASH_ITEMS];
  for (const skill of skills) {
    items.push({
      kind: "skill",
      label: `/skill:${skill.name}`,
      description: skill.description || "Agent skill",
      skillName: skill.name,
      skillPath: skill.path,
    });
  }
  for (const profile of profiles) {
    items.push({
      kind: "profile",
      label: `/profile:${profile.name}`,
      description: "Apply saved provider profile",
      profileName: profile.name,
    });
  }
  for (const model of models) {
    items.push({
      kind: "model",
      label: `/model:${model}`,
      description: "Switch the active model",
      modelName: model,
    });
  }
  return items;
}

function toolsListText(): string {
  const lines = [`Agent tools (${LOCAL_VISUAL_TOOLS.length}):`, ""];
  for (const tool of LOCAL_VISUAL_TOOLS) {
    const firstLine = tool.description.split("\n")[0].slice(0, 90);
    lines.push(`  ${tool.name.padEnd(22)} ${firstLine}`);
  }
  return lines.join("\n");
}

function providerInfoText(config: ReturnType<typeof useAgentProvider>): string {
  const lines = [
    `Provider: ${providerLabel(config)}`,
    `  Harness:   ${config.kind}`,
    `  Base URL:  ${config.baseUrl || "—"}`,
    `  Model:     ${config.model || "—"}`,
    `  API key:   ${config.apiKeySet ? "set (server-side)" : "not set"}`,
    `  Mode:      ${config.agentMode}`,
    `  Board tools:  ${config.allowLocalBoard ? "on" : "off"}`,
    `  Web fetch:    ${config.allowWebFetch ? "on" : "off"}`,
    `  Share ctx:    ${config.shareHermesContext ? "on" : "off"}`,
  ];
  return lines.join("\n");
}

/**
 * Handle a slash command typed in the chat input. Returns the assistant
 * reply text, or `null` when the command has no textual reply (e.g. /clear,
 * /new, /stop) or the input is not a recognized command (send to the model).
 */
function handleSlashCommand(
  text: string,
  config: ReturnType<typeof useAgentProvider>,
  actions: { clear: () => void; newChat: () => void; stop: () => void },
): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...rest] = trimmed.split(/\s+/);
  const name = rawName.toLowerCase();
  const arg = rest.join(" ").trim();

  switch (name) {
    case "/help":
    case "/?":
      return buildHelpText();
    case "/clear":
      actions.clear();
      return null;
    case "/new":
      actions.newChat();
      return null;
    case "/tools":
      return toolsListText();
    case "/provider":
    case "/status":
      return providerInfoText(config);
    case "/stop":
      actions.stop();
      return null;
    default:
      if (arg) return null; // "/foo bar" — not a command, send to the model
      return `Unknown command "${rawName}". Type /help to list available commands.`;
  }
}

export function AgentChat({ labelOverride }: AgentChatProps) {
  const providerConfig = useAgentProvider();
  const isGatewayProvider = providerConfig.baseUrl.replace(/\/+$/, "") === "/hermes-gw";
  const [savedSessions, setSavedSessions] = useState<SavedChatSession[]>(loadSavedChatSessions);
  const [activeSessionId, setActiveSessionId] = useState(() => {
    try {
      return window.sessionStorage.getItem(ACTIVE_CHAT_SESSION_KEY)
        || Object.keys(loadActiveHermesRuns()).at(-1)
        || createChatSessionId();
    } catch (_error) {
      return createChatSessionId();
    }
  });
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const activeId = window.sessionStorage.getItem(ACTIVE_CHAT_SESSION_KEY);
      if (activeId && loadActiveHermesRuns()[activeId]) return loadSessionMessages();
      const saved = loadSavedChatSessions().find((session) => session.id === activeId);
      return saved?.messages ?? loadSessionMessages();
    } catch (_error) {
      return loadSessionMessages();
    }
  });
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isRecordingSpeech, setIsRecordingSpeech] = useState(false);
  const [isTranscribingSpeech, setIsTranscribingSpeech] = useState(false);
  const [speechRepliesEnabled, setSpeechRepliesEnabled] = useState(() => {
    try { return window.localStorage.getItem(SPEECH_REPLIES_STORAGE_KEY) === "true"; } catch { return false; }
  });
  const [speechVoices, setSpeechVoices] = useState<SpeechVoice[]>([]);
  const [selectedSpeechVoice, setSelectedSpeechVoice] = useState(() => {
    try { return window.localStorage.getItem(SPEECH_VOICE_STORAGE_KEY) || "af_heart"; } catch { return "af_heart"; }
  });
  const [speechNotice, setSpeechNotice] = useState("");
  const [speechBusyMessageId, setSpeechBusyMessageId] = useState<string | null>(null);
  const [speechAudio, setSpeechAudio] = useState<{ messageId: string; voice: string; blob: Blob } | null>(null);
  const [playingSpeechMessageId, setPlayingSpeechMessageId] = useState<string | null>(null);
  const [reasoningText, setReasoningText] = useState("");
  const [steerInput, setSteerInput] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [steerMessage, setSteerMessage] = useState<string | null>(null);
  const [showSavedChats, setShowSavedChats] = useState(false);
  /** Context chips attached to the next user message (via @-mentions). */
  const [contextChips, setContextChips] = useState<ContextChip[]>([]);
  /** Files/images uploaded from this computer, attached to the next message. */
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Image data URLs per user message id (kept in memory only, never persisted). */
  const imagesByMessage = useRef(new Map<string, string[]>());
  /** Follow-up suggestion chips shown after the last assistant answer. */
  const [followUps, setFollowUps] = useState<string[]>([]);
  /** Model context window (tokens) pulled from the backend; 0 = unknown. */
  const [contextLength, setContextLength] = useState<number>(0);
  /** Prompt-token usage reported by Hermes for the last completed gateway turn. */
  const [lastTurnInputTokens, setLastTurnInputTokens] = useState<number | null>(null);
  /** Current context occupancy reported by the Hermes gateway, when available. */
  const [gatewayContext, setGatewayContext] = useState<HermesContextUsage | null>(null);
  /** Transient notice shown when the conversation was auto-compressed. */
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  /** "Jump to latest" pill: shown when the user scrolled up during a stream. */
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const speechRecorderRef = useRef<MediaRecorder | null>(null);
  const speechStreamRef = useRef<MediaStream | null>(null);
  const speechChunksRef = useRef<Blob[]>([]);
  const speechRecordingBytesRef = useRef(0);
  const speechRecordingTooLargeRef = useRef(false);
  const speechTimerRef = useRef<number | null>(null);
  const speechTranscriptionAbortRef = useRef<AbortController | null>(null);
  const speechSynthesisAbortRef = useRef<AbortController | null>(null);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechObjectUrlRef = useRef<string | null>(null);
  const speechRepliesEnabledRef = useRef(speechRepliesEnabled);
  const selectedSpeechVoiceRef = useRef(selectedSpeechVoice);
  speechRepliesEnabledRef.current = speechRepliesEnabled;
  selectedSpeechVoiceRef.current = selectedSpeechVoice;
  const remoteSessionsLoaded = useRef(false);
  /** Abort controller for the in-flight turn; the Stop button aborts it. */
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  /** Pending mutating tool calls awaiting inline approval (ask mode). */
  const pendingApprovals = useRef(new Map<string, { resolve: (approved: boolean) => void }>());
  /** Last user message text, for the "regenerate" action. */
  const lastUserTextRef = useRef("");

  // ---- Slash command menu (OpenCode / Copilot style) ---------------------
  const [menuSkills, setMenuSkills] = useState<AgentSkill[]>([]);
  const [menuModels, setMenuModels] = useState<string[]>([]);
  const [menuProfiles, setMenuProfiles] = useState<{ name: string }[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuNotice, setMenuNotice] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const slashQuery = parseSlashQuery(input);
  const slashItems = buildSlashItems(menuSkills, menuProfiles, menuModels);
  const visibleSlashItems = filterSlashItems(slashQuery, slashItems, SLASH_MENU_MAX_ITEMS);
  const slashMenuOpen = slashQuery.active && visibleSlashItems.length > 0;

  // ---- @-mention context menu (VS Code style) ----------------------------
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionQuery = parseMentionQuery(input);
  const visibleMentionItems = filterMentionItems(mentionQuery.token, MENTION_ITEMS);
  const mentionMenuOpen = mentionQuery.active && visibleMentionItems.length > 0;

  useEffect(() => {
    setMentionIndex(0);
  }, [input]);

  function applyMentionItem(item: MentionItem) {
    if (item.kind === "upload") {
      setInput((current) => current.replace(/@([^\s@]*)$/, ""));
      fileInputRef.current?.click();
      return;
    }
    // @board attaches immediately; @file/@web/@note keep the token in the
    // input so the user can type the path/URL/note, then send.
    if (item.kind === "board") {
      setInput((current) => applyMentionToInput(current, item));
      setContextChips((chips) =>
        chips.some((chip) => chip.kind === "board") ? chips : [...chips, { kind: "board", label: "Spatial Board" }],
      );
    } else {
      setInput((current) => applyMentionToInput(current, item));
    }
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setUploadingCount((count) => count + files.length);
    for (const file of files) {
      try {
        const attachment = await prepareAttachment(file, compatClient.uploadFile);
        setPendingAttachments((current) => [...current, attachment]);
      } catch (error) {
        setMenuNotice(`Upload failed for ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setUploadingCount((count) => count - 1);
      }
    }
    inputRef.current?.focus();
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleMentionKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionMenuOpen) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((index) => (index + 1) % visibleMentionItems.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((index) => (index - 1 + visibleMentionItems.length) % visibleMentionItems.length);
      return true;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      const item = visibleMentionItems[mentionIndex];
      if (item) applyMentionItem(item);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput((current) => current.replace(/@([^\s@]*)$/, ""));
      return true;
    }
    return false;
  }

  // Load the menu's data sources (skills, profiles, models) on mount.
  useEffect(() => {
    let cancelled = false;
    fetchAgentSkills()
      .then((data) => {
        if (!cancelled) setMenuSkills(data.skills);
      })
      .catch(() => {
        // Skills endpoint unavailable (e.g. Tauri shell without the dashboard) —
        // the menu still works with built-in commands.
      });
    setMenuProfiles(loadProviderProfiles().map((profile) => ({ name: profile.name })));
    const onSettingsReady = () => setMenuProfiles(loadProviderProfiles().map((profile) => ({ name: profile.name })));
    window.addEventListener(PROVIDER_SETTINGS_READY_EVENT, onSettingsReady);
    return () => {
      cancelled = true;
      window.removeEventListener(PROVIDER_SETTINGS_READY_EVENT, onSettingsReady);
    };
  }, []);

  // Refresh the model list when the API endpoint changes.
  useEffect(() => {
    if (providerConfig.kind !== "api" || !providerConfig.baseUrl) {
      setMenuModels([]);
      return;
    }
    let cancelled = false;
    import("../agent/agentData")
      .then(({ fetchModels }) => {
        const endpoint = endpointFor(providerConfig);
        return fetchModels(endpoint.baseUrl, endpoint.apiKey);
      })
      .then((models) => {
        if (!cancelled) setMenuModels(models);
      })
      .catch(() => {
        if (!cancelled) setMenuModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [providerConfig.kind, providerConfig.baseUrl, providerConfig.apiKeySet]);

  // Pull the model's context window on mount so the meter and auto-compression
  // know the real budget. Fails silently — the meter just stays hidden.
  useEffect(() => {
    let cancelled = false;
    fetchModelContext()
      .then((info) => {
        if (!cancelled && info.ok && info.context_length > 0) {
          setContextLength(info.context_length);
        }
      })
      .catch(() => {
        // Backend unavailable (e.g. Tauri shell without the dashboard) — the
        // context meter simply stays hidden and compression is disabled.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setGatewayContext(null);
    setLastTurnInputTokens(null);
  }, [providerConfig.baseUrl, providerConfig.model]);

  // Estimated tokens in the current conversation, recomputed as messages change.
  const estimatedTokens = estimateTokens(
    messages.map((message) => ({ role: message.role, content: message.content })),
  );

  // Auto-clear the compression notice a few seconds after it appears.
  useEffect(() => {
    if (!contextNotice) return;
    const timer = window.setTimeout(() => setContextNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [contextNotice]);

  // Keep the highlighted item in range as the filtered list changes.
  useEffect(() => {
    setMenuIndex(0);
  }, [input]);

  // Close the menu when clicking outside of it.
  useEffect(() => {
    if (!slashMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setInput((current) => (parseSlashQuery(current).active ? "" : current));
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [slashMenuOpen]);

  function applySlashItem(item: SlashItem) {
    if (item.kind === "command") {
      setInput(item.label);
      return;
    }
    if (item.kind === "skill") {
      const skill = menuSkills.find((candidate) => candidate.name === item.skillName);
      if (skill) {
        if (isGatewayProvider) {
          setInput(`/${skill.name} `);
          setMenuNotice(`Hermes will load the "${skill.name}" skill — add your task, then send.`);
          return;
        }
        setInput(buildSkillPromptHeader(skill));
        setMenuNotice(`Skill "${skill.name}" loaded — add your task, then send.`);
      }
      return;
    }
    if (item.kind === "profile") {
      const profile = loadProviderProfiles().find((candidate) => candidate.name === item.profileName);
      if (profile) {
        applyProviderProfile(profile);
        setMenuNotice(`Provider profile "${profile.name}" applied.`);
      } else {
        setMenuNotice(`Provider profile "${item.profileName}" was not found.`);
      }
      setInput("");
      return;
    }
    if (item.kind === "model") {
      updateAgentProvider({ model: item.modelName ?? "" });
      setMenuNotice(`Model switched to "${item.modelName}".`);
      setInput("");
    }
  }

  function handleSlashKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashMenuOpen) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuIndex((index) => (index + 1) % visibleSlashItems.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuIndex((index) => (index - 1 + visibleSlashItems.length) % visibleSlashItems.length);
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const item = visibleSlashItems[menuIndex];
      if (item) applySlashItem(item);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = visibleSlashItems[menuIndex];
      if (item) {
        applySlashItem(item);
        // Pass the label explicitly — setInput() above is async, so the
        // `input` state read inside sendMessage() would still be stale.
        if (item.kind === "command") void sendMessage(item.label);
      }
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
      return true;
    }
    return false;
  }

  function handleStop() {
    const run = loadActiveHermesRuns()[activeSessionId];
    if (run?.runId.startsWith("live:")) {
      setReasoningText("Stopping Hermes...");
      void hermesLive.interrupt(activeSessionId).catch((error) => setReasoningText(`Stop failed: ${String(error)}`));
      return;
    }
    if (run) {
      const endpoint = endpointFor(providerConfig);
      const client = new HermesClient({ baseUrl: endpoint.baseUrl, model: providerConfig.model, apiKey: endpoint.apiKey });
      abortRef.current?.abort();
      abortRef.current = null;
      saveActiveHermesRun(activeSessionId, null);
      setIsThinking(false);
      setReasoningText("Stopped watching this Hermes run.");
      void client.stopRun(run.runId).catch(() => undefined);
      return;
    }
    if (providerConfig.kind === "api" && providerConfig.baseUrl.replace(/\/+$/, "") === "/hermes-gw") {
      stopRequestedRef.current = true;
      setReasoningText("Stopping Hermes...");
      return;
    }
    abortRef.current?.abort();
  }

  async function refreshSpeechVoices() {
    setSpeechNotice("Loading speech voices…");
    try {
      const result = await fetchSpeechVoices();
      setSpeechVoices(result.voices);
      setSpeechNotice(result.warning || "Speech voices loaded.");
      if (result.voices.length > 0 && !result.voices.some((voice) => voice.id === selectedSpeechVoiceRef.current)) {
        setSelectedSpeechVoice(result.voices[0].id);
      }
    } catch (error) {
      setSpeechVoices([]);
      setSpeechNotice(error instanceof Error ? error.message : "Could not load speech voices");
    }
  }

  function stopSpeechPlayback() {
    const player = speechAudioRef.current;
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.currentTime = 0;
      speechAudioRef.current = null;
    }
    if (speechObjectUrlRef.current) {
      URL.revokeObjectURL(speechObjectUrlRef.current);
      speechObjectUrlRef.current = null;
    }
    setPlayingSpeechMessageId(null);
  }

  function stopSpeechOutput() {
    speechSynthesisAbortRef.current?.abort();
    stopSpeechPlayback();
    setSpeechNotice("Spoken reply stopped.");
  }

  async function playSpeechAudio(messageId: string, blob: Blob) {
    stopSpeechPlayback();
    const objectUrl = URL.createObjectURL(blob);
    speechObjectUrlRef.current = objectUrl;
    const player = new Audio(objectUrl);
    speechAudioRef.current = player;
    player.onended = () => {
      if (speechAudioRef.current === player) {
        speechAudioRef.current = null;
        setPlayingSpeechMessageId(null);
        if (speechObjectUrlRef.current === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          speechObjectUrlRef.current = null;
        }
      }
    };
    player.onerror = () => setSpeechNotice("Could not play the generated WAV audio.");
    try {
      await player.play();
      setPlayingSpeechMessageId(messageId);
      setSpeechNotice("");
    } catch {
      setSpeechNotice("Audio is ready. Select Play on the assistant reply to listen.");
    }
  }

  async function createSpeechReply(messageId: string, markdown: string) {
    const text = textForSpeech(markdown);
    if (!text) {
      setSpeechNotice("This reply has no speakable text outside code blocks.");
      return;
    }
    if (speechSynthesisAbortRef.current) return;
    const controller = new AbortController();
    speechSynthesisAbortRef.current = controller;
    setSpeechBusyMessageId(messageId);
    setSpeechNotice("Generating spoken reply…");
    const voice = selectedSpeechVoiceRef.current;
    try {
      const blob = await synthesizeSpeech(text, voice, controller.signal);
      setSpeechAudio({ messageId, voice, blob });
      await playSpeechAudio(messageId, blob);
    } catch (error) {
      if (!controller.signal.aborted) setSpeechNotice(error instanceof Error ? error.message : "Speech synthesis failed");
    } finally {
      if (speechSynthesisAbortRef.current === controller) speechSynthesisAbortRef.current = null;
      setSpeechBusyMessageId(null);
    }
  }

  function speakCompletedReply(messageId: string, content: string) {
    if (speechRepliesEnabledRef.current) void createSpeechReply(messageId, content);
  }

  function handleSpeechMessage(messageId: string, content: string) {
    if (playingSpeechMessageId === messageId) {
      stopSpeechPlayback();
      return;
    }
    if (speechAudio?.messageId === messageId && speechAudio.voice === selectedSpeechVoiceRef.current) {
      void playSpeechAudio(messageId, speechAudio.blob);
      return;
    }
    void createSpeechReply(messageId, content);
  }

  function stopSpeechRecording() {
    const recorder = speechRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (speechTimerRef.current !== null) window.clearTimeout(speechTimerRef.current);
    speechTimerRef.current = null;
    recorder.stop();
    setIsRecordingSpeech(false);
  }

  async function startSpeechRecording() {
    if (!window.isSecureContext) {
      setSpeechNotice("Microphone access requires HTTPS or localhost. Open the dashboard through its secure URL or an SSH tunnel.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setSpeechNotice("This browser does not support microphone recording.");
      return;
    }
    let acquiredStream: MediaStream | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      acquiredStream = stream;
      const mime = recordingMimeType();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      speechStreamRef.current = stream;
      acquiredStream = null;
      speechRecorderRef.current = recorder;
      speechChunksRef.current = [];
      speechRecordingBytesRef.current = 0;
      speechRecordingTooLargeRef.current = false;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        speechRecordingBytesRef.current += event.data.size;
        if (speechRecordingBytesRef.current > MAX_SPEECH_RECORDING_BYTES) {
          speechRecordingTooLargeRef.current = true;
          setSpeechNotice("Recording exceeds the 8 MB limit. Shorten it and try again.");
          stopSpeechRecording();
          return;
        }
        speechChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        speechStreamRef.current?.getTracks().forEach((track) => track.stop());
        speechStreamRef.current = null;
        speechRecorderRef.current = null;
        const chunks = speechChunksRef.current;
        speechChunksRef.current = [];
        if (speechRecordingTooLargeRef.current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        if (!blob.size) {
          setSpeechNotice("No microphone audio was recorded.");
          return;
        }
        setIsTranscribingSpeech(true);
        setSpeechNotice("Transcribing recording…");
        const controller = new AbortController();
        speechTranscriptionAbortRef.current = controller;
        try {
          const transcript = await transcribeSpeech(blob, controller.signal);
          if (!transcript.trim()) {
            setSpeechNotice("No speech was recognized. Try recording again.");
          } else {
            setInput((current) => current.trim() ? `${current.trim()}\n${transcript}` : transcript);
            setSpeechNotice("Transcript ready to review. Select Send when you are ready.");
            inputRef.current?.focus();
          }
        } catch (error) {
          if (!controller.signal.aborted) setSpeechNotice(error instanceof Error ? error.message : "Speech transcription failed");
        } finally {
          if (speechTranscriptionAbortRef.current === controller) speechTranscriptionAbortRef.current = null;
          setIsTranscribingSpeech(false);
        }
      };
      recorder.start(500);
      setIsRecordingSpeech(true);
      setSpeechNotice("Recording… select Stop to transcribe.");
      speechTimerRef.current = window.setTimeout(() => {
        setSpeechNotice("Recording limit reached; transcribing the recording.");
        stopSpeechRecording();
      }, MAX_SPEECH_RECORDING_MS);
    } catch (error) {
      acquiredStream?.getTracks().forEach((track) => track.stop());
      setSpeechNotice(error instanceof Error ? `Microphone unavailable: ${error.message}` : "Microphone access was denied or unavailable.");
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(SPEECH_REPLIES_STORAGE_KEY, String(speechRepliesEnabled));
      window.localStorage.setItem(SPEECH_VOICE_STORAGE_KEY, selectedSpeechVoice);
    } catch {
      // Voice preferences are optional; the speech tokens remain server-side.
    }
  }, [speechRepliesEnabled, selectedSpeechVoice]);

  useEffect(() => {
    let active = true;
    void fetchSpeechVoices().then((result) => {
      if (!active) return;
      setSpeechVoices(result.voices);
      if (result.warning) setSpeechNotice(result.warning);
      if (result.voices.length > 0 && !result.voices.some((voice) => voice.id === selectedSpeechVoiceRef.current)) {
        setSelectedSpeechVoice(result.voices[0].id);
      }
    }).catch((error) => {
      if (active) setSpeechNotice(error instanceof Error ? error.message : "Speech services are not configured.");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (speechTimerRef.current !== null) window.clearTimeout(speechTimerRef.current);
    speechTranscriptionAbortRef.current?.abort();
    speechSynthesisAbortRef.current?.abort();
    const recorder = speechRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    speechStreamRef.current?.getTracks().forEach((track) => track.stop());
    speechAudioRef.current?.pause();
    if (speechObjectUrlRef.current) URL.revokeObjectURL(speechObjectUrlRef.current);
  }, []);

  useEffect(() => {
    void loadRemoteWorkbenchState().then((state) => {
      const remoteSessions = Array.isArray(state?.chat_sessions) ? state.chat_sessions as SavedChatSession[] : [];
      if (remoteSessions.length > 0) {
        setSavedSessions((current) => {
          const merged = [...remoteSessions, ...current.filter((item) => !remoteSessions.some((remote) => remote.id === item.id))]
            .sort((left, right) => right.updatedAt - left.updatedAt);
          try { window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(merged)); } catch (_error) { /* local fallback */ }
          return merged;
        });
      } else if (savedSessions.length > 0) {
        void saveRemoteWorkbenchField("chat_sessions", savedSessions);
      }
      remoteSessionsLoaded.current = true;
    });
  }, []);

  // Keep the current conversation in sessionStorage so a mid-turn reload
  // restores it. Local + synchronous, so it's safe to run on every message
  // change (streaming token). No setState here, so it never re-renders.
  useEffect(() => {
    try {
      if (messages.length === 0) {
        window.sessionStorage.removeItem(CHAT_SESSION_STORAGE_KEY);
      } else {
        window.sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify(messages.slice(-100)));
      }
      window.sessionStorage.setItem(ACTIVE_CHAT_SESSION_KEY, activeSessionId);
    } catch (_error) {
      // Session storage can be unavailable in restricted browser contexts.
    }
  }, [activeSessionId, messages]);

  // Update the saved-chats list + remote copy only when the turn settles,
  // NOT on every streaming token. Persisting per token was hammering the
  // remote endpoint (a GET+PUT per token) and re-rendering the whole chat
  // twice per token.
  useEffect(() => {
    if (isThinking) return; // don't persist a half-streamed conversation
    try {
      if (messages.length === 0) return;
      const firstUserMessage = messages.find((message) => message.role === "user");
      const nextSession: SavedChatSession = {
        id: activeSessionId,
        title: firstUserMessage?.content.slice(0, 48) || "New chat",
        updatedAt: Date.now(),
        messages: messages.slice(-100),
      };
      setSavedSessions((currentSessions) => {
        const existing = currentSessions.find((session) => session.id === activeSessionId);
        const lastExisting = existing?.messages[existing.messages.length - 1];
        const lastNext = nextSession.messages[nextSession.messages.length - 1];
        // Skip the no-op re-render when the session content is unchanged.
        if (
          existing &&
          existing.messages.length === nextSession.messages.length &&
          lastExisting?.id === lastNext?.id &&
          lastExisting?.content === lastNext?.content
        ) {
          return currentSessions;
        }
        const nextSessions = [nextSession, ...currentSessions.filter((session) => session.id !== activeSessionId)]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 50);
        window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(nextSessions));
        if (remoteSessionsLoaded.current) void saveRemoteWorkbenchField("chat_sessions", nextSessions);
        return nextSessions;
      });
    } catch (_error) {
      // Session storage can be unavailable in restricted browser contexts.
    }
  }, [activeSessionId, messages, isThinking]);

  useEffect(() => {
    window.dispatchEvent(new Event(CHAT_SESSIONS_CHANGED_EVENT));
  }, [savedSessions]);

  useEffect(() => {
    const handleLoad = (event: Event) => {
      if (isThinking) return;
      const session = (event as CustomEvent<SavedChatSession>).detail;
      if (!session) return;
      setActiveSessionId(session.id);
      setLastTurnInputTokens(null);
      setGatewayContext(null);
      setMessages(session.messages);
      setInput("");
      setReasoningText("");
      setShowSavedChats(false);
    };
    window.addEventListener(LOAD_CHAT_SESSION_EVENT, handleLoad);
    return () => window.removeEventListener(LOAD_CHAT_SESSION_EVENT, handleLoad);
  }, [isThinking]);

  function handleNewChat() {
    if (isThinking) return;
    const nextId = createChatSessionId();
    setActiveSessionId(nextId);
    setLastTurnInputTokens(null);
    setGatewayContext(null);
    setMessages([]);
    setInput("");
    setReasoningText("");
    setSteerInput("");
    setSteerMessage(null);
    setShowSavedChats(false);
  }

  function handleLoadChat(session: SavedChatSession) {
    if (isThinking) return;
    setActiveSessionId(session.id);
    setLastTurnInputTokens(null);
    setGatewayContext(null);
    setMessages(session.messages);
    setInput("");
    setReasoningText("");
    setSteerInput("");
    setSteerMessage(null);
    setShowSavedChats(false);
  }

  async function watchLiveHermesTurn(chatId: string, run: ActiveHermesRun, signal: AbortSignal) {
    setMessages((current) => {
      const next = [...current];
      if (!next.some((message) => message.id === run.userId)) next.push({ id: run.userId, role: "user", content: run.userText, timestamp: Date.now() });
      if (!next.some((message) => message.id === run.assistantId)) next.push({ id: run.assistantId, role: "assistant", content: "", timestamp: Date.now() });
      return next;
    });
    setReasoningText("Hermes is working...");
    const decided = new Map<string, "done" | "denied">();
    const config = providerConfig;
    const turn = await followHermesTurn(chatId, Number(run.runId.slice(5)) || 0, (current) => {
      const toolCalls: ToolCallRecord[] = [
        ...current.tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          summary: tool.args.replace(/\s+/g, " ").slice(0, 90),
          args: tool.args,
          status: tool.status,
          output: tool.output,
        })),
        ...current.approvals.map((approval) => ({
          id: approval.id,
          name: approval.toolName,
          summary: [approval.description, approval.command].filter(Boolean).join(": "),
          args: approval.command,
          status: decided.get(approval.id) ?? ("pending" as const),
        })),
      ];
      patchMessage(run.assistantId, {
        content: current.text,
        reasoning: current.reasoning || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      setReasoningText(current.status || (current.text ? "" : "Hermes is working..."));
      if (current.usage) {
        if (current.usage.inputTokens) setLastTurnInputTokens(current.usage.inputTokens);
        if (current.usage.contextMax > 0) {
          setGatewayContext({
            contextUsed: current.usage.contextUsed,
            contextMax: current.usage.contextMax,
            contextPercent: current.usage.contextPercent,
            source: "hermes",
            estimated: current.usage.estimated,
          });
        }
      }
      for (const approval of current.approvals) {
        if (decided.has(approval.id) || pendingApprovals.current.has(approval.id)) continue;
        void askToolApproval(approval.id, config).then((approved) => {
          decided.set(approval.id, approved ? "done" : "denied");
          return hermesLive.respond(chatId, approval.id, approved ? "once" : "deny");
        }).catch(() => undefined);
      }
    }, signal);
    const content = turn.outcome === "complete"
      ? turn.text || "(empty response)"
      : `${turn.text ? `${turn.text}\n\n` : ""}${turn.outcome === "interrupted" ? "⏹ Stopped." : `Hermes ${turn.outcome}: ${turn.error}`}`;
    patchMessage(run.assistantId, { content });
    setReasoningText("");
    if (turn.outcome === "complete") {
      setSteerMessage((current) => current === "Steer queued for the next tool step." ? "Steer delivered." : current);
      setFollowUps(buildFollowUps(content));
      speakCompletedReply(run.assistantId, content);
    }
    saveActiveHermesRun(chatId, null);
  }

  async function watchHermesRun(client: HermesClient, sessionId: string, run: ActiveHermesRun, signal: AbortSignal) {
    if (run.runId.startsWith("live:")) return watchLiveHermesTurn(sessionId, run, signal);
    setMessages((current) => {
      const next = [...current];
      if (!next.some((message) => message.id === run.userId)) next.push({ id: run.userId, role: "user", content: run.userText, timestamp: Date.now() });
      if (!next.some((message) => message.id === run.assistantId)) next.push({ id: run.assistantId, role: "assistant", content: "", timestamp: Date.now() });
      return next;
    });
    setReasoningText("Hermes is working...");
    let streamedText = "";
    const result = await client.waitForRun(run.runId, {
      onDelta: (text) => {
        streamedText += text;
        patchMessage(run.assistantId, { content: streamedText });
      },
      onStatus: setReasoningText,
    }, signal);
    const answer = result.output || streamedText;
    if (typeof result.pending_steer === "string" && result.pending_steer.trim()) {
      setInput((current) => [result.pending_steer, current].filter(Boolean).join("\n\n"));
      setSteerMessage("Steer was not delivered. It is ready in the composer.");
    } else if (result.status === "completed") {
      setSteerMessage((current) => current === "Steer queued for the next tool step." ? "Steer delivered." : current);
    }
    const content = result.status === "completed"
      ? answer || "(empty response)"
      : `${answer ? `${answer}\n\n` : ""}Run ${result.status}${result.error ? `: ${result.error}` : ""}`;
    patchMessage(run.assistantId, { content });
    if (result.status === "completed") {
      setFollowUps(buildFollowUps(content));
      speakCompletedReply(run.assistantId, content);
    }
    saveActiveHermesRun(sessionId, null);
  }

  useEffect(() => {
    const run = loadActiveHermesRuns()[activeSessionId];
    if (!run || providerConfig.kind !== "api" || providerConfig.baseUrl.replace(/\/+$/, "") !== "/hermes-gw") return;
    const endpoint = endpointFor(providerConfig);
    const client = new HermesClient({ baseUrl: endpoint.baseUrl, model: providerConfig.model, apiKey: endpoint.apiKey });
    const controller = new AbortController();
    abortRef.current = controller;
    setIsThinking(true);
    void watchHermesRun(client, activeSessionId, run, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (/failed with (400|401|403|404|410)/.test(String(error))) {
          saveActiveHermesRun(activeSessionId, null);
          setSteerMessage(null);
          setReasoningText("The saved Hermes run is no longer available. Start a new chat or send a new message.");
          patchMessage(run.assistantId, { content: `Run unavailable: ${String(error)}` });
        } else {
          setReasoningText(`Connection lost: ${String(error)}. The run is still saved.`);
        }
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setIsThinking(false);
        }
      });
    return () => controller.abort();
  }, [activeSessionId, providerConfig.kind, providerConfig.baseUrl, providerConfig.model]);

  async function handleSteer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = steerInput.trim();
    const run = loadActiveHermesRuns()[activeSessionId];
    if (!run || !text) return;
    const endpoint = endpointFor(providerConfig);
    const client = new HermesClient({ baseUrl: endpoint.baseUrl, model: providerConfig.model, apiKey: endpoint.apiKey });
    setSteerBusy(true);
    setSteerMessage(null);
    try {
      if (run.runId.startsWith("live:")) {
        const result = await hermesLive.steer(activeSessionId, text);
        if (result.status === "rejected") throw new Error("Hermes is not running a turn right now; send it as a message.");
      } else {
        const result = await client.steerRun(run.runId, text);
        if (!result.accepted) throw new Error("Hermes did not accept the steer.");
      }
      setSteerInput("");
      setSteerMessage("Steer queued for the next tool step.");
    } catch (error) {
      setSteerMessage(`Steer not sent: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSteerBusy(false);
    }
  }

  // Auto-scroll follows the stream, but if the user scrolled up we leave
  // them alone and show a "jump to latest" pill instead (VS Code behavior).
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (nearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, isThinking, reasoningText]);

  function handleMessagesScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    nearBottomRef.current = distance < 80;
    setShowJumpToBottom(!nearBottomRef.current);
  }

  function jumpToBottom() {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    nearBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  /** Update one message in place (streaming fills, tool cards, reasoning). */
  function patchMessage(id: string, patch: Partial<SavedChatMessage>) {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }

  /** Resolve a pending inline tool approval (Approve/Deny on the card). */
  function resolveToolApproval(id: string, approved: boolean) {
    const pending = pendingApprovals.current.get(id);
    if (pending) {
      pendingApprovals.current.delete(id);
      pending.resolve(approved);
    }
  }

  /** Ask (or auto-decide) whether a mutating tool may run. */
  function askToolApproval(recordId: string, config: ReturnType<typeof useAgentProvider>): Promise<boolean> {
    if (config.agentMode === "auto") return Promise.resolve(true);
    if (config.agentMode === "plan") return Promise.resolve(false);
    // "ask" mode: wait for the inline Approve/Deny on the tool card.
    return new Promise<boolean>((resolve) => {
      pendingApprovals.current.set(recordId, { resolve });
    });
  }

  const label = labelOverride ?? providerLabel(providerConfig);

  async function sendMessage(overrideText?: string) {
    const attachments = overrideText === undefined ? pendingAttachments : [];
    const rawText = (overrideText ?? input).trim() || (attachments.length > 0 ? "Please look at the attached files." : "");
    if (!rawText || isThinking || uploadingCount > 0 || isRecordingSpeech || isTranscribingSpeech) return;

    // A Hermes command can resolve to a prompt (skills, /plan, /queue, ...) that runs as a normal turn.
    let commandPrompt: string | null = null;
    const gatewayCommand = isGatewayProvider ? parseGatewaySlashCommand(rawText) : null;
    if (gatewayCommand) {
      setInput("");
      setFollowUps([]);
      setIsThinking(true);
      setReasoningText(`Running ${gatewayCommand.split(/\s/, 1)[0]} in Hermes...`);
      const reply = (content: string) => {
        const timestamp = Date.now();
        setMessages((current) => [
          ...current,
          { id: `user-${timestamp}`, role: "user", content: rawText, timestamp },
          { id: `assistant-${timestamp}`, role: "assistant", content, timestamp },
        ]);
      };
      try {
        const result = await hermesLive.command(activeSessionId, gatewayCommand);
        if (result.type === "send") {
          commandPrompt = result.message;
          if (result.notice) setMenuNotice(result.notice);
        } else if (result.type === "prefill") {
          setInput(result.message);
          if (result.notice) setMenuNotice(result.notice);
        } else {
          const help = /^\/help\s*$/i.test(gatewayCommand) ? `\n\nWorkbench-only commands: /new, /clear, /stop, /provider` : "";
          // Hermes formats command output as fixed-width text tables.
          const body = result.output.includes("\n") ? `\`\`\`text\n${result.output}\n\`\`\`` : result.output;
          reply([body, result.warning ? `Warning: ${result.warning}` : ""].filter(Boolean).join("\n\n") + help);
        }
      } catch (error) {
        reply(`Gateway command failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsThinking(false);
        setReasoningText("");
      }
      if (commandPrompt === null) return;
    }

    // Slash commands are handled locally and never reach the model.
    const slashReply = commandPrompt === null
      ? handleSlashCommand(rawText, providerConfig, {
        clear: () => setMessages([]),
        newChat: handleNewChat,
        stop: handleStop,
      })
      : null;
    if (slashReply !== null) {
      setInput("");
      setFollowUps([]);
      setMessages((current) => [
        ...current,
        { id: `user-${Date.now()}`, role: "user", content: rawText, timestamp: Date.now() },
        { id: `assistant-${Date.now()}`, role: "assistant", content: slashReply, timestamp: Date.now() },
      ]);
      return;
    }

    // @-mention context: parse chips out of the text (e.g. "@board …",
    // "@file /path …") and merge with chips attached via the @ menu.
    const { chips: parsedChips, cleanText } = parseContextChips(rawText);
    const attachmentChips: ContextChip[] = attachments.map((item) => ({
      kind: item.dataUrl ? "image" : "upload",
      label: item.name,
      value: item.path,
    }));
    const chips = [...contextChips, ...parsedChips, ...attachmentChips];
    const text = cleanText || rawText;
    const promptText = [buildContextPrompt(chips), buildAttachmentPrompt(attachments), commandPrompt ?? text]
      .filter(Boolean)
      .join("\n\n");
    const images = attachments.flatMap((item) => (item.dataUrl ? [item.dataUrl] : []));

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
      context: chips.length > 0 ? chips : undefined,
    };
    if (images.length > 0) imagesByMessage.current.set(userMessage.id, images);
    const history = [...messages, userMessage];
    // What the model sees: this turn carries the context/attachment preamble and images.
    const apiHistory: ChatMlMessage[] = history.map((message) => ({
      role: message.role,
      content: message.id === userMessage.id ? promptText : message.content,
      images: imagesByMessage.current.get(message.id),
    }));
    setMessages(history);
    setInput("");
    setContextChips([]);
    setPendingAttachments([]);
    setFollowUps([]);
    setLastTurnInputTokens(null);
    setGatewayContext(null);
    setIsThinking(true);
    setReasoningText("");
    setSteerMessage(null);
    stopRequestedRef.current = false;
    lastUserTextRef.current = promptText;

    // The Stop button aborts the in-flight request (and any pending awaits).
    const abortController = new AbortController();
    abortRef.current = abortController;
    const signal = abortController.signal;

    try {
      if (providerConfig.kind === "api") {
        // The Hermes gateway runs the FULL agent (its own tools, skills, and
        // memory) — a single turn can take minutes. Use streaming (SSE with
        // live __status__ progress) and a long timeout instead of the short
        // non-streaming call used for bare model endpoints.
        const isGateway = isGatewayProvider;
        const endpoint = endpointFor(providerConfig);
        const client = new HermesClient({
          baseUrl: endpoint.baseUrl,
          model: providerConfig.model,
          apiKey: endpoint.apiKey,
          timeoutMs: 60_000,
        });
        if (!client.available) {
          throw new Error("API provider is not configured (Base URL and Model are required in Agent Workbench).");
        }
        // No injected system prompt — the harness/model owns its own persona.
        const sharedContext =
          providerConfig.shareHermesContext && !isGateway
            ? await fetchSharedHermesContext(providerConfig.agentMode)
            : null;
        let convo: ChatMlMessage[] = sharedContext ? [sharedContext, ...apiHistory] : apiHistory;
        // Auto-compression: if the conversation is approaching the model's
        // context window, collapse older turns into a rolling summary so the
        // stream doesn't drop mid-generation. The visible transcript is left
        // untouched — only what we send to the model is compressed.
        if (!isGateway && contextLength > 0 && shouldCompress(estimateTokens(convo), contextLength)) {
          convo = compressConversation(convo);
          setContextNotice(
            `🗜️ Context near the ${formatTokenCount(contextLength)}-token limit — older turns were summarized to keep the agent running.`,
          );
        }
        const assistantId = `assistant-${Date.now()}`;
        let streamedReasoning = "";
        let streamedText = "";
        const gatewaySessionStorageKey = `spatial-workbench.hermes-session.${activeSessionId}`;
        const gatewaySessionId = isGateway ? window.sessionStorage.getItem(gatewaySessionStorageKey) || undefined : undefined;
        // Seed an empty assistant bubble and fill it in as the SSE stream
        // arrives, so the reply renders token-by-token.
        setMessages((current) => [
          ...current,
          { id: assistantId, role: "assistant", content: "", timestamp: Date.now() },
        ]);
        if (isGateway) {
          const started = await hermesLive.prompt(activeSessionId, promptText, images);
          const run = { runId: `live:${started.cursor}`, assistantId, userId: userMessage.id, userText: text };
          saveActiveHermesRun(activeSessionId, run);
          if (stopRequestedRef.current) await hermesLive.interrupt(activeSessionId);
          await watchLiveHermesTurn(activeSessionId, run, signal);
          return;
        }
        if (!isGateway && (providerConfig.allowLocalBoard || providerConfig.allowWebFetch)) {
          let toolConvo = [...convo];
          let reply = "";
          const toolRecords: ToolCallRecord[] = [];
          for (let iteration = 0; iteration < 6; iteration += 1) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            setReasoningText(iteration === 0 ? "Planning with the Spatial Board…" : "Updating the Spatial Board…");
            const result = await client.chat(toolConvo, LOCAL_VISUAL_TOOLS, { maxTokens: 1024, signal });
            reply = result.text;
            if (result.toolCalls.length === 0) break;

            toolConvo = [
              ...toolConvo,
              {
                role: "assistant",
                content: result.text,
                tool_calls: result.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
            ];
            for (const call of result.toolCalls) {
              const mutating = isMutatingTool(call.name);
              const record: ToolCallRecord = {
                id: call.id,
                name: call.name,
                summary: summarizeToolCall(call.name, call.arguments),
                args: formatArgs(call.arguments),
                // Mutating calls in "ask" mode wait for inline approval first.
                status: mutating && providerConfig.agentMode === "ask" ? "pending" : "running",
              };
              toolRecords.push(record);
              patchMessage(assistantId, { toolCalls: [...toolRecords] });

              let output: string;
              if (mutating && providerConfig.agentMode === "plan") {
                output = "Plan mode: tool was not executed. Describe the proposed board change for approval.";
                record.status = "denied";
              } else if (mutating && !(await askToolApproval(record.id, providerConfig))) {
                output = "User denied this Spatial Board change.";
                record.status = "denied";
              } else {
                record.status = "running";
                patchMessage(assistantId, { toolCalls: [...toolRecords] });
                if (signal.aborted) throw new DOMException("Aborted", "AbortError");
                const toolResult = await executeTool(call.name, call.arguments, providerConfig.terminalToken);
                output = toolResult.output;
                record.status = toolResult.ok ? "done" : "error";
              }
              record.output = truncateOutput(output);
              patchMessage(assistantId, { toolCalls: [...toolRecords] });
              toolConvo.push({ role: "tool", content: output, tool_call_id: call.id, name: call.name });
            }
          }
          patchMessage(assistantId, {
            content: reply || streamedReasoning || "(empty response)",
            reasoning: streamedReasoning || undefined,
          });
          setFollowUps(buildFollowUps(reply));
          speakCompletedReply(assistantId, reply);
          return;
        }
        const streamed = await client.chatStream(
          convo,
          {
            onDelta: (chunk) => {
              setReasoningText("");
              streamedText += chunk;
              patchMessage(assistantId, { content: streamedText });
            },
            onReasoning: (chunk) => {
              streamedReasoning += chunk;
              setReasoningText(streamedReasoning);
              patchMessage(assistantId, { reasoning: streamedReasoning });
            },
            onStatus: (status) => setReasoningText(status),
            onUsage: (usage) => {
              if (isGateway) setLastTurnInputTokens(usage.promptTokens);
            },
            onContext: (context) => {
              if (isGateway) setGatewayContext(context);
            },
            onSessionId: (sessionId) => {
              if (isGateway) window.sessionStorage.setItem(gatewaySessionStorageKey, sessionId);
            },
          },
          {
            maxTokens: isGateway ? 4096 : 1024,
            sessionId: gatewaySessionId,
            workbenchChatId: isGateway ? activeSessionId : undefined,
            signal,
          },
        );
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const legacyCommands = extractLegacyBashCalls(streamed);
        if (legacyCommands.length > 0) {
          const continuation: ChatMlMessage[] = [
            ...convo,
            { role: "assistant", content: streamed },
          ];
          const results: string[] = [];
          const toolRecords: ToolCallRecord[] = [];
          for (const command of legacyCommands) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            const record: ToolCallRecord = {
              id: `bash-${Date.now()}-${results.length}`,
              name: "execute_bash_command",
              summary: summarizeToolCall("execute_bash_command", { command }),
              args: formatArgs({ command }),
              status: providerConfig.agentMode === "ask" ? "pending" : "running",
            };
            toolRecords.push(record);
            patchMessage(assistantId, { toolCalls: [...toolRecords] });

            const approved = await askToolApproval(record.id, providerConfig);
            const output = providerConfig.agentMode === "plan"
              ? "Plan mode: Bash command was not executed."
              : approved
                ? (await executeTool("execute_bash_command", { command }, providerConfig.terminalToken)).output
                : "User denied the Bash command.";
            record.status = approved && providerConfig.agentMode !== "plan" ? "done" : "denied";
            record.output = truncateOutput(output);
            patchMessage(assistantId, { toolCalls: [...toolRecords] });
            results.push(output);
            continuation.push({ role: "tool", name: "Bash", content: output });
          }
          const followup = await client.chat(continuation, [], { maxTokens: 1024, signal });
          const cleaned = followup.text || `Tool result:\n${results.join("\n\n")}`;
          patchMessage(assistantId, { content: cleaned, reasoning: streamedReasoning || undefined });
          setFollowUps(buildFollowUps(cleaned));
          speakCompletedReply(assistantId, cleaned);
          return;
        }
        if (!streamed) {
          patchMessage(assistantId, {
            content: streamedReasoning || "(empty response)",
            reasoning: streamedReasoning || undefined,
          });
        } else {
          setFollowUps(buildFollowUps(streamed));
          speakCompletedReply(assistantId, streamed);
        }
        return;
      }

      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const resolved = { ...providerConfig, cliPath: await resolveCliPath(providerConfig) };
      const result = await runCliTurn(resolved, buildCliPrompt(history, promptText));
      const reply = result.ok
        ? result.output
        : `⚠ CLI harness failed: ${result.error ?? "unknown error"}\n${result.output}`;
      const assistantId = `assistant-${Date.now()}`;
      setMessages((current) => [
        ...current,
        { id: assistantId, role: "assistant", content: reply, timestamp: Date.now() },
      ]);
      setFollowUps(buildFollowUps(reply));
      if (result.ok) speakCompletedReply(assistantId, reply);
    } catch (error) {
      const aborted =
        signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const message = error instanceof Error ? error.message : String(error);
      const errorContent = aborted
        ? "⏹ Stopped by user."
        : `⚠ Agent error: ${message}`;
      setMessages((current) => {
        const last = current[current.length - 1];
        // If a streaming bubble was seeded but never filled, replace it with
        // the error instead of appending a second assistant message.
        if (last && last.role === "assistant" && last.content === "") {
          return current.map((m) => (m.id === last.id ? { ...m, content: errorContent } : m));
        }
        return [
          ...current,
          { id: `error-${Date.now()}`, role: "assistant", content: errorContent, timestamp: Date.now() },
        ];
      });
    } finally {
      abortRef.current = null;
      setIsThinking(false);
      setReasoningText("");
      // Any approvals still pending when the turn ends resolve as denied,
      // and their cards flip from "pending" to "denied".
      for (const pending of pendingApprovals.current.values()) pending.resolve(false);
      pendingApprovals.current.clear();
      setMessages((current) =>
        current.map((message) =>
          message.toolCalls?.some((call) => call.status === "pending")
            ? {
                ...message,
                toolCalls: message.toolCalls.map((call) =>
                  call.status === "pending" ? { ...call, status: "denied" as const } : call,
                ),
              }
            : message,
        ),
      );
    }
  }

  /** Regenerate the last assistant answer (VS Code "regenerate" action). */
  function handleRegenerate() {
    if (isThinking) return;
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    // Drop the trailing assistant turn(s) and re-run the last user request.
    let cut = messages.length;
    while (cut > 0 && messages[cut - 1].role !== "user") cut -= 1;
    setMessages(messages.slice(0, cut));
    void sendMessage(lastUser.content);
  }

  /** Copy a message's content to the clipboard. */
  async function handleCopyMessage(message: ChatMessage) {
    await copyText(message.content);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (handleSlashKeyDown(event)) return;
    if (handleMentionKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // Context meter: how full the model's window is, with a color level.
  const contextPct =
    contextLength > 0 ? Math.min(100, Math.round((estimatedTokens / contextLength) * 100)) : 0;
  const contextLevel = contextPct < 50 ? "ok" : contextPct < 70 ? "warn" : "high";

  return (
    <section className="agent-chat" aria-label="Agent chat">
      <header className="agent-chat-header">
        <div className="agent-chat-title">
          <h3>Agent</h3>
          <span className="agent-chat-provider" title="Live provider — switch it in Agent Workbench">
            {label}
          </span>
        </div>
        <div className="agent-chat-controls">
          {isGatewayProvider ? (
            gatewayContext ? (
              <span
                className={`context-meter context-meter-${gatewayContext.contextPercent < 50 ? "ok" : gatewayContext.contextPercent < 70 ? "warn" : "high"}`}
                aria-label={`${gatewayContext.estimated ? "Estimated " : ""}gateway context: ${gatewayContext.contextUsed.toLocaleString()} of ${gatewayContext.contextMax.toLocaleString()} tokens`}
                title={`Hermes context (${gatewayContext.source}): ${formatTokenCount(gatewayContext.contextUsed)} of ${formatTokenCount(gatewayContext.contextMax)} tokens.`}
              >
                <span className="context-meter-bar" aria-hidden="true">
                  <span className="context-meter-fill" style={{ width: `${gatewayContext.contextPercent}%` }} />
                </span>
                <span className="context-meter-label">
                  {gatewayContext.estimated ? "~" : ""}{formatTokenCount(gatewayContext.contextUsed)}/{formatTokenCount(gatewayContext.contextMax)}
                </span>
              </span>
            ) : lastTurnInputTokens !== null ? (
              <span
                className="context-meter"
                aria-label={`Last turn input: ${lastTurnInputTokens.toLocaleString()} tokens`}
                title="Prompt-token usage reported by Hermes for the last completed turn; it may aggregate multiple model calls and is not current context-window occupancy."
              >
                <span className="context-meter-label">Turn input {formatTokenCount(lastTurnInputTokens)}</span>
              </span>
            ) : (
              <span
                className="context-meter"
                aria-label={`Approximate visible conversation: ${estimatedTokens.toLocaleString()} tokens`}
                title="Approximate token count for visible conversation text only. It excludes Hermes system instructions, tools, skills, memory, and other gateway context."
              >
                <span className="context-meter-label">Visible ~{formatTokenCount(estimatedTokens)}</span>
              </span>
            )
          ) : contextLength > 0 && (
            <span
              className={`context-meter context-meter-${contextLevel}`}
              title={`~${formatTokenCount(estimatedTokens)} of ${formatTokenCount(contextLength)} tokens estimated. Older turns are auto-summarized as this fills up.`}
            >
              <span className="context-meter-bar" aria-hidden="true">
                <span className="context-meter-fill" style={{ width: `${contextPct}%` }} />
              </span>
              <span className="context-meter-label">
                {formatTokenCount(estimatedTokens)}/{formatTokenCount(contextLength)}
              </span>
            </span>
          )}
          <div className="agent-chat-actions">
            <button className="btn secondary small" type="button" onClick={handleNewChat} disabled={isThinking}>
              New chat
            </button>
            <button className="btn secondary small" type="button" onClick={() => setShowSavedChats((visible) => !visible)}>
              Load chat
            </button>
            <button
              className="agent-chat-icon-btn"
              type="button"
              title="Clear conversation"
              aria-label="Clear conversation"
              onClick={() => setMessages([])}
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>
      </header>
      {showSavedChats && (
        <div className="saved-chat-list" aria-label="Saved chats">
          {savedSessions.length === 0 ? (
            <span className="muted small">No saved chats yet.</span>
          ) : (
            savedSessions.map((session) => (
              <button
                className={`saved-chat-item ${session.id === activeSessionId ? "active" : ""}`}
                type="button"
                key={session.id}
                onClick={() => handleLoadChat(session)}
              >
                <strong>{session.title}</strong>
                <span>{new Date(session.updatedAt).toLocaleString()}</span>
              </button>
            ))
          )}
        </div>
      )}

      {contextNotice && (
        <div className="context-notice" role="status">
          {contextNotice}
        </div>
      )}

      <div className="agent-chat-messages" ref={scrollRef} role="log" aria-label="Chat messages" onScroll={handleMessagesScroll}>
        {messages.length === 0 && !isThinking ? (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-meta">
              <span className="chat-msg-role">Agent</span>
            </div>
            <div className="chat-msg-content md">
              <p>
                Agent chat is wired to <strong>{label}</strong>. Send a message to talk to it.
                Switch harnesses or endpoints live from Agent Workbench.
              </p>
              <p className="muted">
                Type <code className="md-inline-code">/</code> for commands &amp; skills, or{" "}
                <code className="md-inline-code">@</code> to attach context (upload, board, files, web, notes). You can also paste or drop files here.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message, index) => {
            const isLastAssistant =
              message.role === "assistant" &&
              index === messages.map((m) => m.role).lastIndexOf("assistant");
            const showThinking =
              message.role === "assistant" && isThinking && !message.content && !message.toolCalls?.length;
            return (
              <div key={message.id} className={`chat-msg chat-msg-${message.role}`}>
                <div className="chat-msg-meta">
                  <span className="chat-msg-role">{message.role === "user" ? "You" : "Agent"}</span>
                  {message.timestamp ? <span className="chat-msg-time">{formatTime(message.timestamp)}</span> : null}
                </div>
                {message.context && message.context.length > 0 ? (
                  <div className="context-chips" aria-label="Attached context">
                    {message.context.map((chip, chipIndex) => (
                      <span key={`${chip.kind}-${chipIndex}`} className={`context-chip context-chip-${chip.kind}`}>
                        <Icon name={chipIcon(chip.kind)} size={13} />
                        {chip.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {imagesByMessage.current.get(message.id)?.length ? (
                  <div className="chat-msg-images">
                    {imagesByMessage.current.get(message.id)!.map((url, imageIndex) => (
                      <img key={imageIndex} src={url} alt={`Attached image ${imageIndex + 1}`} />
                    ))}
                  </div>
                ) : null}
                {message.toolCalls && message.toolCalls.length > 0 ? (
                  <div className="tool-cards">
                    {message.toolCalls.map((call) => (
                      <ToolCallCard
                        key={call.id}
                        call={call}
                        live={isThinking && isLastAssistant}
                        onApprove={(id) => resolveToolApproval(id, true)}
                        onDeny={(id) => resolveToolApproval(id, false)}
                      />
                    ))}
                  </div>
                ) : null}
                {message.reasoning ? (
                  <details className="reasoning-block">
                    <summary>Thinking</summary>
                    <div className="reasoning-content md">
                      <Markdown content={message.reasoning} />
                    </div>
                  </details>
                ) : null}
                {message.content || showThinking ? (
                  <div className="chat-msg-content md">
                    {showThinking ? (
                      <span className="thinking">{reasoningText || "Thinking…"}</span>
                    ) : (
                      <Markdown content={message.content} />
                    )}
                  </div>
                ) : null}
                <div className="chat-msg-actions">
                  <button
                    className="chat-msg-action"
                    type="button"
                    title="Copy message"
                    aria-label="Copy message"
                    onClick={() => void handleCopyMessage(message)}
                  >
                    ⧉
                  </button>
                  {message.role === "assistant" && message.content && !showThinking ? (
                    <button
                      className="chat-msg-action"
                      type="button"
                      title={playingSpeechMessageId === message.id ? "Stop spoken reply" : speechAudio?.messageId === message.id ? "Play spoken reply" : "Speak reply"}
                      aria-label={playingSpeechMessageId === message.id ? "Stop spoken reply" : speechAudio?.messageId === message.id ? "Play spoken reply" : "Speak reply"}
                      disabled={speechBusyMessageId === message.id}
                      onClick={() => {
                        if (playingSpeechMessageId === message.id) stopSpeechPlayback();
                        else void handleSpeechMessage(message.id, message.content);
                      }}
                    >
                      <Icon name={playingSpeechMessageId === message.id ? "stop" : speechAudio?.messageId === message.id ? "play" : "speaker"} size={14} />
                    </button>
                  ) : null}
                  {isLastAssistant && !isThinking ? (
                    <button
                      className="chat-msg-action"
                      type="button"
                      title="Regenerate response"
                      aria-label="Regenerate response"
                      onClick={handleRegenerate}
                    >
                      ↻
                    </button>
                  ) : null}
                  {message.role === "assistant" ? (
                    <>
                      <button className="chat-msg-action" type="button" title="Good response" aria-label="Good response">
                        👍
                      </button>
                      <button className="chat-msg-action" type="button" title="Bad response" aria-label="Bad response">
                        👎
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        {isThinking && !(messages.length > 0 && messages[messages.length - 1].role === "assistant") ? (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-meta">
              <span className="chat-msg-role">Agent</span>
            </div>
            <p className="chat-msg-content thinking">{reasoningText || "Thinking…"}</p>
          </div>
        ) : null}
        {followUps.length > 0 && !isThinking ? (
          <div className="follow-ups" aria-label="Suggested follow-ups">
            {followUps.map((suggestion) => (
              <button key={suggestion} className="follow-up-chip" type="button" onClick={() => void sendMessage(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        {showJumpToBottom ? (
          <button className="jump-to-bottom" type="button" onClick={jumpToBottom} title="Jump to latest message" aria-label="Jump to latest message">
            ↓
          </button>
        ) : null}
      </div>

      {menuNotice && (
        <div className="slash-menu-notice" role="status">
          {menuNotice}
          <button className="slash-menu-notice-close" type="button" onClick={() => setMenuNotice(null)} aria-label="Dismiss notice">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <div className="agent-chat-input-row">
        {isThinking && providerConfig.kind === "api" && providerConfig.baseUrl.replace(/\/+$/, "") === "/hermes-gw"
          && loadActiveHermesRuns()[activeSessionId] ? (
          <form className="agent-chat-steer" onSubmit={(event) => void handleSteer(event)}>
            <input
              aria-label="Steer running agent"
              value={steerInput}
              onChange={(event) => setSteerInput(event.target.value)}
              placeholder="Add guidance"
              maxLength={2000}
              disabled={steerBusy}
            />
            <button className="btn secondary small" type="submit" disabled={steerBusy || !steerInput.trim()} title="Queue guidance for the next tool step">
              <Icon name="bolt" size={14} /> Steer
            </button>
          </form>
        ) : null}
        {steerMessage && <p className="agent-chat-steer-status" role="status">{steerMessage}</p>}
        {slashMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label="Slash commands" ref={menuRef}>
            {visibleSlashItems.map((item, index) => (
              <button
                key={`${item.kind}-${item.label}`}
                type="button"
                role="option"
                aria-selected={index === menuIndex}
                className={`slash-menu-item ${item.kind} ${index === menuIndex ? "active" : ""}`}
                onMouseEnter={() => setMenuIndex(index)}
                onClick={() => applySlashItem(item)}
              >
                <span className="slash-menu-label">{item.label}</span>
                <span className="slash-menu-desc">{item.description}</span>
              </button>
            ))}
            <div className="slash-menu-hint">↑↓ navigate · Tab/Enter select · Esc close</div>
          </div>
        )}
        {mentionMenuOpen && (
          <MentionMenu
            items={visibleMentionItems}
            index={mentionIndex}
            onHover={setMentionIndex}
            onSelect={applyMentionItem}
          />
        )}
        <div
          className="agent-chat-input-shell"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {pendingAttachments.length > 0 || uploadingCount > 0 ? (
            <div className="context-chips context-chips-input" aria-label="Uploaded files">
              {pendingAttachments.map((item, itemIndex) => (
                <span key={item.path} className={`context-chip context-chip-${item.dataUrl ? "image" : "upload"}`} title={item.path}>
                  {item.dataUrl ? (
                    <img className="context-chip-thumb" src={item.dataUrl} alt="" />
                  ) : (
                    <Icon name="file" size={13} />
                  )}
                  {item.name}
                  <button
                    type="button"
                    className="context-chip-remove"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => setPendingAttachments((current) => current.filter((_, i) => i !== itemIndex))}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
              {uploadingCount > 0 ? <span className="context-chip">Uploading {uploadingCount}…</span> : null}
            </div>
          ) : null}
          {contextChips.length > 0 ? (
            <div className="context-chips context-chips-input" aria-label="Attached context">
              {contextChips.map((chip, chipIndex) => (
                <span key={`${chip.kind}-${chipIndex}`} className={`context-chip context-chip-${chip.kind}`}>
                  <Icon name={chipIcon(chip.kind)} size={13} />
                  {chip.label}
                  <button
                    type="button"
                    className="context-chip-remove"
                    aria-label={`Remove ${chip.label}`}
                    onClick={() =>
                      setContextChips((current) => current.filter((_, i) => i !== chipIndex))
                    }
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="agent-chat-input"
            rows={2}
            placeholder="Message the agent… (type / for commands, @ for context, Shift+Enter for newline)"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            aria-label="Agent chat input"
          />
          <div className="agent-chat-input-toolbar">
            <button
              className="agent-chat-add-context"
              type="button"
              title="Add context or upload files (@)"
              aria-label="Add context"
              onClick={() => {
                setInput((current) => current.replace(/@([^\s@]*)$/, "") + "@");
                inputRef.current?.focus();
              }}
            >
              +
            </button>
            <ModePicker />
            <ModelPicker models={menuModels} />
            <span className="agent-chat-input-toolbar-spacer" />
            {isThinking && (
              <button
                className="agent-chat-stop"
                type="button"
                onClick={handleStop}
                title="Stop the current agent turn"
                aria-label="Stop agent"
              >
                ■ Stop
              </button>
            )}
            <button
              className="agent-chat-send"
              type="button"
              onClick={() => void sendMessage()}
              disabled={(!input.trim() && pendingAttachments.length === 0) || isThinking || uploadingCount > 0 || isRecordingSpeech || isTranscribingSpeech}
              aria-label="Send message"
            >
              ↑
            </button>
          </div>
          <div className="agent-chat-speech-controls" aria-label="Voice chat controls">
            <button
              className={`agent-chat-speech-mic${isRecordingSpeech ? " recording" : ""}`}
              type="button"
              disabled={!window.isSecureContext || isThinking || isTranscribingSpeech}
              title={!window.isSecureContext ? "Microphone access requires HTTPS or localhost" : isRecordingSpeech ? "Stop recording and transcribe" : "Push to talk"}
              aria-label={isRecordingSpeech ? "Stop recording and transcribe" : "Start microphone recording"}
              onClick={() => isRecordingSpeech ? stopSpeechRecording() : void startSpeechRecording()}
            >
              <Icon name={isRecordingSpeech ? "stop" : "microphone"} size={15} />
              <span>{isRecordingSpeech ? "Stop" : "Talk"}</span>
            </button>
            <label className="agent-chat-voice-select-label" title={speechVoices.length ? "Voice for spoken replies" : "Voice catalogue is empty; af_heart is an unverified fallback"}>
              <span>Voice</span>
              <select aria-label="Spoken reply voice" value={selectedSpeechVoice} onChange={(event) => setSelectedSpeechVoice(event.target.value)}>
                {speechVoices.length > 0
                  ? speechVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)
                  : <option value={selectedSpeechVoice}>{selectedSpeechVoice} (not listed)</option>}
              </select>
            </label>
            <label className="agent-chat-speech-toggle" title="Automatically speak completed assistant replies">
              <input type="checkbox" checked={speechRepliesEnabled} onChange={(event) => {
                setSpeechRepliesEnabled(event.target.checked);
                if (!event.target.checked) {
                  speechSynthesisAbortRef.current?.abort();
                  stopSpeechPlayback();
                }
              }} />
              <Icon name="speaker" size={14} />
              <span>Speak replies</span>
            </label>
            <button className="agent-chat-speech-refresh" type="button" title="Reload available voices" aria-label="Reload speech voices" onClick={() => void refreshSpeechVoices()}>
              <Icon name="refresh" size={14} />
            </button>
            {(playingSpeechMessageId || speechBusyMessageId) && <button className="agent-chat-speech-refresh" type="button" title="Stop spoken reply" aria-label="Stop spoken reply" onClick={stopSpeechOutput}><Icon name="stop" size={14} /></button>}
          </div>
          {!window.isSecureContext && <div className="agent-chat-speech-notice" role="status">Microphone access requires HTTPS or localhost.</div>}
          {speechNotice && <div className="agent-chat-speech-notice" role="status">{speechNotice}</div>}
        </div>
      </div>
    </section>
  );
}
