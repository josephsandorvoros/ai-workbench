# AI Workbench

*Your models. Your rules.*

AI Workbench is a self-hosted place to think, build, and keep AI-assisted work organized. Instead of jumping between a chat window, a code editor, a notes app, and a collection of scripts, you can bring those activities together in one browser-based workspace.

It works with the AI models and services you choose. You can chat with an assistant, work with project files, save research and ideas, make visual boards, create artifacts, or ask a coordinated team of coding workers to tackle a larger task.

## What you can do

### Talk with an assistant

Use the Agent workspace to chat with Hermes, OpenCode, or a compatible model endpoint. The assistant can use available tools and context to help with research, planning, writing, and work inside the workspace. Provider settings let you choose which service and model to use.

### Work with projects and notes

Browse and edit project files in the browser, including code and Markdown. Keep reference material in the built-in wiki, organize it into pages, and connect pages with simple `[[links]]`. The workspace is also where job files and outputs are kept.

### Think visually

Use the Spatial Board to sketch ideas, systems, and relationships. The board can be updated by hand or through supported assistant tools, and is shared through the Workbench rather than being tied to one browser session.

### Make and inspect deliverables

Create HTML artifacts and preview common file types in the workspace. This is useful for reports, prototypes, visualizations, and other outputs you want to review or share. Generated artifacts remain files you can revisit, not just text buried in a chat.

For a project that needs a server, use **Run app** in Projects or ask an agent with the Workbench preview tools to start it. The Workbench shows the running app and output through its existing browser URL, without exposing another port. These temporary previews run with the agent user's permissions, not in a Jobs worker sandbox. Stop them explicitly when finished; WebSocket hot reload is not supported.

### Delegate larger coding tasks

The Jobs board is for work that benefits from a plan and multiple steps:

1. Describe the outcome you want.
2. Hermes reviews the request, asks for missing information when needed, and proposes a plan.
3. Review or edit the plan, then approve it before workers begin.
4. OpenCode workers carry out the subtasks. Independent tasks can run at the same time; dependent tasks wait for their prerequisites.
5. Review results, logs, and files, then use the final summary to decide what to do next.

Jobs include reusable worker profiles, attempt history, retries, live logs, and optional token or spending limits. For repository work, workers use separate Git branches and worktrees. You can inspect the patches and explicitly merge a completed worker's changes into the local base branch. Workers do not push changes to a remote repository.

## How the assistants fit together

Think of Hermes as the coordinator: it talks with you, helps clarify and plan jobs, and brings results together. OpenCode is the coding tool used by job workers, and can also be used directly. They can use different models. By default, OpenCode and job workers use `opencode/big-pickle`; Hermes needs an OpenAI-compatible model endpoint configured for chat, planning, and summaries.

For longer tasks, the Jobs board adds structure and review points. For quick questions or a small edit, use the Agent or Project workspace directly.

## A few common ways to use it

- **Explore an idea:** ask the assistant to research a topic, keep the useful notes in the wiki, and sketch the system on the Spatial Board.
- **Make a small change:** open a project file, discuss the change with the assistant, and edit or review the result in the workspace.
- **Build something with several steps:** create a job, review its plan, let workers handle the subtasks, then inspect the output and patches before merging.
- **Produce a shareable result:** create a report or prototype as an artifact, preview it, and refine it before sharing.
- **Check the machine:** use the resource indicators to see CPU, memory, disk, and available GPU information. Choose whether the dashboard should show the Workbench host or a configured monitor.

## Safety and privacy

AI Workbench runs on a machine you control, but model requests may go to other services. The OpenCode default, Big Pickle, is hosted; do not send confidential material to a provider unless its data-handling terms are acceptable to you. You can configure a different OpenCode model or endpoint. API keys entered in Workbench settings are kept on the server and are not sent to the browser as readable settings.

Job workers run in a separate Docker-in-Docker sandbox by default. The sandbox blocks access to private network ranges unless you explicitly allow an exception, while still allowing internet access for model services. It is an isolation layer, not a guarantee that arbitrary code is harmless. Hermes' own terminal sandbox is a separate setting.

The web interface has no application login by default. A fresh installer binds it to the VM's loopback address so you can access it through an SSH tunnel. If you choose to make it reachable from other machines, put authentication and network restrictions in place first. The Workbench terminal token protects terminal features; it is not a login for the whole site.

## Getting started

For the latest CLI installer, manual Compose instructions, security setup, and operating details, see the [deployment guide](deploy/README.md). The deployment guide covers the model endpoint needed for Hermes, sandbox choices, and how to reach the interface safely.
