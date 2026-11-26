import { useEffect, useRef, useState, type PointerEvent } from "react";

type Point = { x: number; y: number };
type Edit =
  | { kind: "draw"; points: Point[]; color: string; width: number }
  | { kind: "crop"; x: number; y: number; width: number; height: number };

const MAX_PIXELS = 16_000_000;

export function ImageEditor({ source, name, onDirtyChange, onSaveCopy, onCancel }: {
  source: string;
  name: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveCopy: (file: File) => Promise<void>;
  onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const drawing = useRef<Point[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [draft, setDraft] = useState<Point[]>([]);
  const [color, setColor] = useState("#e75075");
  const [width, setWidth] = useState(4);
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [filename, setFilename] = useState(`${name.replace(/\.[^.]+$/, "")}-edited.png`);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = new Image();
    next.onload = () => {
      if (next.naturalWidth * next.naturalHeight > MAX_PIXELS) {
        setError("This image is too large to edit in Canvas (maximum 16 megapixels).");
        return;
      }
      image.current = next;
      setCrop({ x: 0, y: 0, width: next.naturalWidth, height: next.naturalHeight });
      setLoaded(true);
    };
    next.onerror = () => setError("Could not load this image for editing.");
    next.src = source;
    return () => { next.onload = null; next.onerror = null; };
  }, [source]);

  useEffect(() => {
    onDirtyChange(edits.length > 0);
  }, [edits, onDirtyChange]);

  useEffect(() => {
    const element = canvas.current;
    const sourceImage = image.current;
    if (!element || !sourceImage || !loaded) return;
    element.width = sourceImage.naturalWidth;
    element.height = sourceImage.naturalHeight;
    const context = element.getContext("2d");
    if (!context) { setError("Image editing is unavailable in this browser."); return; }
    context.drawImage(sourceImage, 0, 0);
    const renderStroke = (edit: Extract<Edit, { kind: "draw" }>) => {
      if (!edit.points.length) return;
      context.strokeStyle = edit.color;
      context.fillStyle = edit.color;
      context.lineWidth = edit.width;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(edit.points[0].x, edit.points[0].y);
      for (const point of edit.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
      if (edit.points.length === 1) {
        context.beginPath();
        context.arc(edit.points[0].x, edit.points[0].y, edit.width / 2, 0, Math.PI * 2);
        context.fill();
      }
    };
    for (const edit of edits) {
      if (edit.kind === "draw") renderStroke(edit);
      else {
        const copy = document.createElement("canvas");
        copy.width = edit.width;
        copy.height = edit.height;
        const copyContext = copy.getContext("2d");
        if (!copyContext) { setError("Image editing is unavailable in this browser."); return; }
        copyContext.drawImage(element, edit.x, edit.y, edit.width, edit.height, 0, 0, edit.width, edit.height);
        element.width = edit.width;
        element.height = edit.height;
        context.drawImage(copy, 0, 0);
      }
    }
    if (draft.length) renderStroke({ kind: "draw", points: draft, color, width });
    setDimensions((current) => current.width === element.width && current.height === element.height
      ? current : { width: element.width, height: element.height });
  }, [loaded, edits, draft, color, width]);

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(event.currentTarget.width, (event.clientX - bounds.left) * event.currentTarget.width / bounds.width)),
      y: Math.max(0, Math.min(event.currentTarget.height, (event.clientY - bounds.top) * event.currentTarget.height / bounds.height)),
    };
  }

  async function saveCopy() {
    if (!canvas.current || saving) return;
    if (!filename.trim() || !/\.png$/i.test(filename.trim())) {
      setError("Enter a PNG filename for the edited copy.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const element = canvas.current;
      const blob = await new Promise<Blob>((resolve, reject) => {
        element.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode the image.")), "image/png");
      });
      if (blob.size > 10 * 1024 * 1024) throw new Error("The edited image exceeds the 10 MB upload limit.");
      await onSaveCopy(new File([blob], filename.trim(), { type: "image/png" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  function applyCrop() {
    const { x, y, width: w, height: h } = crop;
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > dimensions.width || y + h > dimensions.height) {
      setError("Enter a crop rectangle within the image dimensions.");
      return;
    }
    setError("");
    setEdits((current) => [...current, { kind: "crop", x, y, width: w, height: h }]);
  }

  return <div className="image-editor">
    <div className="image-editor-toolbar">
      <label>Pen <input aria-label="Pen color" type="color" value={color} onChange={(event) => setColor(event.target.value)} disabled={saving} /></label>
      <label>Width <input aria-label="Pen width" type="number" min="1" max="100" value={width} onChange={(event) => setWidth(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} disabled={saving} /></label>
      <button className="btn secondary" type="button" disabled={!edits.length || saving} onClick={() => setEdits((current) => current.slice(0, -1))}>Undo</button>
      <span>{dimensions.width} × {dimensions.height} px · Draw on the image to annotate.</span>
    </div>
    <div className="image-editor-crop" role="group" aria-label="Crop in pixels">
      {(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{field === "x" ? "Left" : field === "y" ? "Top" : field === "width" ? "Width" : "Height"}
        <input type="number" min="0" aria-label={`Crop ${field}`} value={crop[field]} onChange={(event) => setCrop((current) => ({ ...current, [field]: Number(event.target.value) }))} disabled={saving} />
      </label>)}
      <button className="btn secondary" type="button" disabled={!loaded || saving} onClick={applyCrop}>Crop</button>
    </div>
    <div className="image-editor-stage">
      <canvas ref={canvas} aria-label="Image annotation canvas" onPointerDown={(event) => {
        if (!loaded || saving || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drawing.current = [point(event)];
        setDraft(drawing.current);
      }} onPointerMove={(event) => {
        if (!drawing.current) return;
        drawing.current = [...drawing.current, point(event)];
        setDraft(drawing.current);
      }} onPointerUp={() => {
        const points = drawing.current;
        if (points?.length) setEdits((current) => [...current, { kind: "draw", points, color, width }]);
        drawing.current = null;
        setDraft([]);
      }} onPointerCancel={() => { drawing.current = null; setDraft([]); }} />
    </div>
    <div className="image-editor-save">
      <label>Copy filename <input value={filename} onChange={(event) => setFilename(event.target.value)} disabled={saving} /></label>
      <button className="btn" type="button" disabled={!loaded || !edits.length || saving} onClick={() => void saveCopy()}>{saving ? "Saving..." : "Save PNG copy"}</button>
      <button className="btn secondary" type="button" disabled={saving} onClick={onCancel}>Close editor</button>
    </div>
    <p className="document-meta">The original stays unchanged. PNG copies flatten animation and layers.</p>
    {error && <p className="document-error" role="alert">{error}</p>}
  </div>;
}
