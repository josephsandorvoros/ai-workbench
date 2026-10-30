## Agent context

Open **Agent Workbench** to browse the available skills, memory, sessions, and tools. Selecting an item opens its detail pane. Context belongs to the configured agent host; it is not automatically the same as another Hermes installation or a Discord session.

## Skills and memory

Select a skill or memory file to read it. Use **Edit** to change its source and **Save** to persist the change. Delete acts on the selected file; check the path and keep a backup before removing important context.

An installed skill is not a guarantee it will be used on every request. The selected harness decides which context and tools to load. Jobs can copy selected Hermes skills into a worker snapshot; later edits do not rewrite that snapshot.

## Sessions

Use **Load chat** in the Agent panel to revisit a saved Workbench conversation. In the sessions view, select an agent session to inspect it; where supported, **Save** makes a saved-chat copy and **Load session** opens that copy in the Agent panel.

Loading a transcript is not the same as resuming every internal state of the original harness. An active worker, terminal process, or external chat integration may have a different session.

## Tools and browser tools

**Tools** shows the Hermes tool registry for inspection. Built-in and MCP schemas are not editable through that view.

**Browser tools** are Workbench-local tool definitions and can be managed separately. Changing them does not change Hermes' own server-side tool registry. Chat mode and policy controls only apply where the corresponding execution path supports them.

See [Chat](#help/chat), [Models & connections](#help/connections), and [Security & sandboxing](#help/security) for the boundaries between these paths.