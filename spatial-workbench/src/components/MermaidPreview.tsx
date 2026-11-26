import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", flowchart: { htmlLabels: false } });

export function MermaidPreview({ content }: { content: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void mermaid.render(`diagram${id}`, content).then((result) => {
        if (active) { setSvg(result.svg); setError(""); }
      }).catch((reason: unknown) => {
        if (active) { setSvg(""); setError(reason instanceof Error ? reason.message : String(reason)); }
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [content, id]);

  if (error) return <div className="diagram-preview-error" role="alert">Cannot render diagram: {error}</div>;
  return <iframe
    className="document-html-preview"
    title="Mermaid diagram preview"
    sandbox=""
    srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;padding:24px}svg{max-width:100%;height:auto}</style>${svg}`}
  />;
}
