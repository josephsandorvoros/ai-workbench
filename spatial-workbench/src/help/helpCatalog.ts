export type HelpGroup = "Start here" | "Daily work" | "Agents & jobs" | "Administration" | "Reference";

export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  group: HelpGroup;
  keywords: string[];
}

export interface HelpArticle extends HelpTopic {
  content: string;
}

export const HELP_GROUPS: HelpGroup[] = ["Start here", "Daily work", "Agents & jobs", "Administration", "Reference"];

export const HELP_TOPICS: HelpTopic[] = [
  { id: "getting-started", title: "Getting started", summary: "Find your way around and choose the right workflow.", group: "Start here", keywords: ["welcome", "first use", "navigation", "overview"] },
  { id: "chat", title: "Chat with your agent", summary: "Connections, context, commands, and conversation controls.", group: "Daily work", keywords: ["Hermes", "Discord", "gateway", "attachments", "slash", "stop"] },
  { id: "projects", title: "Project files", summary: "Edit workspace files and run managed live app previews.", group: "Daily work", keywords: ["editor", "Monaco", "folders", "code", "save", "Run app", "live preview", "terminal token", "MCP"] },
  { id: "wiki", title: "Wiki & notes", summary: "Read and edit Markdown pages with linked notes.", group: "Daily work", keywords: ["knowledge", "wikilinks", "search", "Obsidian"] },
  { id: "artifacts", title: "Artifacts & job outputs", summary: "Inspect deliverables and preview HTML in Projects.", group: "Daily work", keywords: ["preview", "reports", "outputs", "download", "source"] },
  { id: "spatial-board", title: "Spatial Board", summary: "Sketch systems and relationships on the shared canvas.", group: "Daily work", keywords: ["Excalidraw", "diagram", "drawing", "canvas"] },
  { id: "sessions", title: "Sessions, skills & memory", summary: "Browse agent context and revisit saved conversations.", group: "Daily work", keywords: ["history", "load chat", "tools", "browser tools", "agent workbench"] },
  { id: "connections", title: "Models & connections", summary: "Configure Hermes, main OpenCode, and worker endpoints independently.", group: "Agents & jobs", keywords: ["OpenAI", "API key", "custom endpoint", "local model", "provider", "credentials"] },
  { id: "jobs", title: "Plan & run a job", summary: "Create a request, review the plan, and inspect worker results.", group: "Agents & jobs", keywords: ["approve", "subtasks", "dependencies", "replanning", "collating", "attachments"] },
  { id: "worker-profiles", title: "Worker profiles & project review", summary: "Reuse worker roles, inspect attempts, and explicitly merge local changes.", group: "Agents & jobs", keywords: ["retry", "worktree", "Git", "branch", "budget", "permissions", "merge"] },
  { id: "free-models", title: "Free model tracker", summary: "Browse free Zen and API models, capabilities, and limits.", group: "Agents & jobs", keywords: ["OpenCode Zen", "ClawLabs", "copy ID", "24 hours", "refresh", "context window"] },
  { id: "terminal", title: "Terminal & CLI", summary: "Use the agent-host shell and launch interactive assistants.", group: "Administration", keywords: ["token", "shell", "commands", "Hermes TUI", "OpenCode"] },
  { id: "monitoring", title: "Resource monitor", summary: "Choose a monitor and read CPU, memory, GPU, and disk usage.", group: "Administration", keywords: ["Glances", "VRAM", "temperature", "SSH", "stats"] },
  { id: "security", title: "Security & sandboxing", summary: "Understand access control, model privacy, and worker isolation.", group: "Administration", keywords: ["authentication", "LAN", "firewall", "Pangolin", "proxy", "policy", "secrets"] },
  { id: "maintenance", title: "Updates & backups", summary: "Use component Update buttons, redeploy images, and protect persistent data.", group: "Administration", keywords: ["upgrade", "volumes", "restore", "Docker", "latest", "release", "managed updates", "re-pull", "redeploy", "recovery"] },
  { id: "troubleshooting", title: "Troubleshooting", summary: "Find the next check when a connection, job, or preview fails.", group: "Administration", keywords: ["error", "unavailable", "401", "403", "429", "blocked", "cannot connect"] },
  { id: "deployment-reference", title: "Deployment reference", summary: "The complete repository deployment guide, included with this installation.", group: "Reference", keywords: ["installer", "Compose", "environment variables", "configuration", "VM"] },
];

export function searchHelp(articles: HelpArticle[], query: string): HelpArticle[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return articles;
  return articles.map((article, index) => {
    const title = `${article.title} ${article.keywords.join(" ")}`.toLowerCase();
    const description = `${article.summary} ${article.group}`.toLowerCase();
    const body = article.content.toLowerCase();
    const matches = terms.every((term) => title.includes(term) || description.includes(term) || body.includes(term));
    const score = terms.reduce((total, term) => total + (title.includes(term) ? 4 : description.includes(term) ? 2 : 1), 0);
    return { article, index, matches, score };
  }).filter((result) => result.matches)
    .sort((first, second) => second.score - first.score || first.index - second.index)
    .map((result) => result.article);
}

export function helpLinkTarget(href: string): string | null {
  if (!href.startsWith("#help/")) return null;
  const id = href.slice("#help/".length);
  return HELP_TOPICS.some((topic) => topic.id === id) ? id : null;
}