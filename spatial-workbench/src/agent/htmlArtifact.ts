export const HTML_ARTIFACT_KEY = "homelabSpatialWorkbench.htmlArtifact.v1";
export const HTML_ARTIFACT_EVENT = "homelabSpatialWorkbench.htmlArtifactChanged";
export const HTML_ARTIFACT_SNAPSHOTS_KEY = "homelabSpatialWorkbench.htmlArtifactSnapshots.v1";

export interface HtmlArtifact {
  name: string;
  html: string;
  updatedAt: number;
}

export interface HtmlArtifactSnapshot extends HtmlArtifact {
  id: string;
}

export const DEFAULT_HTML_ARTIFACT = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>New artifact</title></head>
<body><main><h1>New HTML artifact</h1><p>Ask the agent to shape this artifact.</p></main></body>
</html>`;

export function loadHtmlArtifact(): HtmlArtifact {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HTML_ARTIFACT_KEY) || "null") as HtmlArtifact | null;
    return parsed?.html ? parsed : { name: "New artifact", html: DEFAULT_HTML_ARTIFACT, updatedAt: Date.now() };
  } catch (_error) {
    return { name: "New artifact", html: DEFAULT_HTML_ARTIFACT, updatedAt: Date.now() };
  }
}

export function saveHtmlArtifact(artifact: HtmlArtifact) {
  window.localStorage.setItem(HTML_ARTIFACT_KEY, JSON.stringify(artifact));
  window.dispatchEvent(new Event(HTML_ARTIFACT_EVENT));
}

export function loadHtmlSnapshots(): HtmlArtifactSnapshot[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HTML_ARTIFACT_SNAPSHOTS_KEY) || "[]") as HtmlArtifactSnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

export function saveHtmlSnapshot(artifact: HtmlArtifact): HtmlArtifactSnapshot[] {
  const existing = loadHtmlSnapshots().find((item) => item.name.toLowerCase() === artifact.name.toLowerCase());
  const snapshot = { ...artifact, id: existing?.id || `html-${Date.now()}` };
  const next = existing
    ? loadHtmlSnapshots().map((item) => item.id === existing.id ? snapshot : item)
    : [snapshot, ...loadHtmlSnapshots()];
  window.localStorage.setItem(HTML_ARTIFACT_SNAPSHOTS_KEY, JSON.stringify(next.slice(0, 25)));
  return next.slice(0, 25);
}
