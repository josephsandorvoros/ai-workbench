import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useRef, useState, type ComponentProps } from "react";

type InitialData = Exclude<NonNullable<ComponentProps<typeof Excalidraw>["initialData"]>, Function | Promise<unknown>>;

export function VisualDiagram({ content, onChange, disabled }: { content: string; onChange: (content: string) => void; disabled: boolean }) {
  const [initial] = useState<InitialData>(() => JSON.parse(content) as InitialData);
  const original = useRef(content);
  const baseline = useRef<string | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const api = useRef<Parameters<NonNullable<ComponentProps<typeof Excalidraw>["excalidrawAPI"]>>[0] | null>(null);

  useEffect(() => {
    if (!shell.current) return;
    const observer = new ResizeObserver(() => api.current?.refresh());
    observer.observe(shell.current);
    return () => observer.disconnect();
  }, []);

  return <div className="visual-diagram" ref={shell} aria-label="Visual diagram editor">
    <Excalidraw
      initialData={initial}
      excalidrawAPI={(instance) => { api.current = instance; }}
      theme="dark"
      viewModeEnabled={disabled}
      UIOptions={{ canvasActions: { loadScene: false, export: false, saveAsImage: false } }}
      onChange={(elements, _appState, files) => {
        const serialized = serializeAsJSON(elements, {}, files, "local");
        if (baseline.current === null) {
          baseline.current = serialized;
        } else {
          onChange(serialized === baseline.current ? original.current : serialized);
        }
      }}
    />
  </div>;
}
