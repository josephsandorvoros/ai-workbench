## Your first session

AI Workbench is a desktop workspace for conversations, files, notes, visual work, and coordinated coding jobs. Hermes is the coordinator; OpenCode supplies coding sessions and job workers. They can use different models.

1. Open **Agent Workbench** and check [Models & connections](#help/connections). Hermes needs a reachable model endpoint; main OpenCode and workers have independent settings.
2. Use the central **Chat** for a quick question. A full Hermes Gateway connection includes Hermes' tools and context; a direct model connection is not the same agent.
3. Open **Projects** for files or **Wiki** for notes. For a larger task, create a [job](#help/jobs) and review its plan before approving workers.

## Choose a workspace

| Workspace | Use it for |
| --- | --- |
| Chat | The central conversation and attached context |
| Documents | Create and edit Canvas items linked to a chat or project |
| Sessions | Browse, inspect, and manage saved conversations |
| Projects | Files, HTML/Markdown previews, managed app previews, artifacts, and job outputs |
| Source Control | Repository changes, staging, commits, branches, history, release tags, and sync |
| Job Board | Planning, approvals, workers, and results |
| Spatial Board | Sketches and diagrams |
| Wiki | Linked Markdown notes |
| Agent Workbench | Connections, skills, memory, sessions, and tools |
| Terminal | Shell access, interactive assistants, and version information |
| Policy Settings | Workbench execution policies and approval controls |

Chat stays in the center. Select a workspace in the left navigation to open it in the right-hand **Canvas**. In Documents or Projects, use **New** in the Canvas header to create an item and **Related work** to find chat-linked items or project files. In **Related work → Project**, use the file dropdown to navigate folders and open a workspace file, and the folder filter to find project Canvas items. Other workspaces remain available from the left navigation.

Drag the canvas's left edge to resize it, or focus that edge and use the arrow keys. **Expand canvas** gives the workspace more room; **Restore canvas size** returns to your chosen width. **Close canvas** or **Chat** hides the canvas; the header's **Canvas** button reopens it without losing editor state. Escape closes an open Canvas menu first, or closes the Canvas when no menu is open.

Phones use a dedicated **chat-only** layout: no tool rail, canvas, monitoring, or administration panels. Saved chats, model selection, attachments, and voice stay available in chat. Tool links do not open the canvas on phones. Browser speech is the mobile default; see [Chat](#help/chat) for voice support and privacy. Larger touch screens up to 1000 pixels wide also use chat-only mode.

On intermediate desktop/tablet widths the canvas can cover the conversation temporarily. Close it to return to chat with your draft intact. A normal desktop page load starts with chat only; existing `?tab=...` links still open the requested tool.

## Before handing over work

Be specific about the outcome, relevant files, and how success should be checked. Review generated files and patches before using them. The Workbench is not an application login or an automatic safety boundary: read [Security & sandboxing](#help/security) before granting access or sending confidential data.

Mobile conversations can also use Hermes integrations such as a Discord bot and gateway.