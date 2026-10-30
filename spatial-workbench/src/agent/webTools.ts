import type { HermesToolSchema } from "./hermesClient";

/**
 * Web tools for the agent. `web_fetch` runs through the dashboard companion
 * API (GET /api/web/fetch) so the fetch happens server-side — the browser
 * never needs CORS, and the server applies scheme/size/timeout guards.
 */
export const WEB_TOOLS: HermesToolSchema[] = [
  {
    name: "web_fetch",
    description:
      "Fetch a public web page (http/https) and return its readable text content. Use for documentation, articles, or any URL the user references. Returns up to ~12k characters; large pages are truncated.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
      },
      required: ["url"],
    },
  },
];
