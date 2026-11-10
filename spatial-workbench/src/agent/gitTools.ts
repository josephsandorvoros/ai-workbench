import type { HermesToolSchema } from "./hermesClient";

const repositoryPath = { type: "string", description: "Workspace-relative repository path under projects/." };
const confirm = { type: "boolean", description: "Must be true only after the user explicitly requested this operation." };

export const GIT_TOOLS: HermesToolSchema[] = [
  {
    name: "git_status",
    description: "Read Git branch, upstream, ahead/behind counts, and changed-file status for a repository under projects/. This is read-only.",
    parameters: { type: "object", properties: { path: repositoryPath }, required: ["path"] },
  },
  {
    name: "git_commit",
    description: "Commit only the selected changed files in a Workbench project. Call only when the user explicitly asked to commit; never include secret files. The commit API requires confirm=true and a one-line message plus author identity.",
    parameters: {
      type: "object",
      properties: {
        path: repositoryPath,
        paths: { type: "array", items: { type: "string" }, description: "Changed workspace-relative file paths selected by the user." },
        message: { type: "string", description: "One-line commit message." },
        author_name: { type: "string" },
        author_email: { type: "string" },
        confirm_sensitive: { type: "boolean", description: "Set true only after the user explicitly reviewed likely secret files such as .env, keys, or credentials." },
        confirm,
      },
      required: ["path", "paths", "message", "author_name", "author_email", "confirm_sensitive", "confirm"],
    },
  },
  {
    name: "git_pull_ff",
    description: "Fetch and fast-forward the current branch from its origin upstream. Call only when the user explicitly requested syncing from the remote; it refuses divergent histories. Requires confirm=true.",
    parameters: { type: "object", properties: { path: repositoryPath, confirm }, required: ["path", "confirm"] },
  },
  {
    name: "git_push",
    description: "Push committed changes on the current branch to origin without force. Call only when the user explicitly requested pushing; never push as an assumed follow-up. Requires confirm=true.",
    parameters: { type: "object", properties: { path: repositoryPath, confirm }, required: ["path", "confirm"] },
  },
];