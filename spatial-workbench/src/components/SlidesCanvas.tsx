import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { importPptx, parseSlidesModel, type SlideElement, type SlidesModel } from "../office/officeCanvas";
import { adjustSlideGeometry } from "../office/officeModels";

function createId(): string {
  return crypto.randomUUID();
}

export function SlidesCanvas({ content, onChange, disabled }: {
  content: string;
  onChange: (content: string) => void;
  disabled: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; mode: "move" | "resize"; startX: number; startY: number; element: SlideElement; stageWidth: number; stageHeight: number } | null>(null);
  const parsed = useMemo(() => {
    try {
      return { model: parseSlidesModel(content), error: "" };
    } catch (reason) {
      return { model: null, error: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [content]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [importing, setImporting] = useState(false);
  const model = parsed.model;
  const slide = model?.slides[slideIndex] ?? model?.slides[0];
  const selected = slide?.elements.find((element) => element.id === selectedId) ?? null;

  function updateModel(transform: (current: SlidesModel) => SlidesModel) {
    if (!model || disabled) return;
    onChange(JSON.stringify(transform(model)));
    setStatus("");
  }

  function updateElement(transform: (element: SlideElement) => SlideElement) {
    if (!selected || !model || disabled) return;
    updateModel((current) => ({
      ...current,
      slides: current.slides.map((item, index) => index === slideIndex
        ? { ...item, elements: item.elements.map((element) => element.id === selected.id ? transform(element) : element) }
        : item),
    }));
  }

  function startGesture(event: PointerEvent<HTMLButtonElement>, mode: "move" | "resize") {
    if (!selected || disabled || event.button !== 0 || !stageRef.current) return;
    const bounds = stageRef.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    gesture.current = { pointerId: event.pointerId, mode, startX: event.clientX, startY: event.clientY, element: selected, stageWidth: bounds.width, stageHeight: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveGesture(event: PointerEvent<HTMLButtonElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || !model) return;
    const dx = (event.clientX - active.startX) / active.stageWidth * model.width;
    const dy = (event.clientY - active.startY) / active.stageHeight * model.height;
    updateElement(() => adjustSlideGeometry(active.element, model.width, model.height, active.mode, dx, dy));
  }

  function keyboardGeometry(event: KeyboardEvent<HTMLButtonElement>, mode: "move" | "resize") {
    if (!model || !selected) return;
    const step = event.shiftKey ? 0.5 : 0.1;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const delta = directions[event.key];
    if (!delta) return;
    event.preventDefault();
    updateElement((element) => adjustSlideGeometry(element, model.width, model.height, mode, delta[0], delta[1]));
  }

  async function handleImport(file?: File) {
    if (!file) return;
    setImporting(true);
    setStatus("");
    try {
      const imported = await importPptx(file);
      onChange(JSON.stringify(imported));
      setSlideIndex(0);
      setSelectedId(null);
      setStatus("Imported editable text and approximate positions. Images, charts, transitions, themes, and animations are not retained.");
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!model || !slide) {
    return <div className="office-canvas-error" role="alert">
      <strong>Canvas slide data cannot be opened.</strong>
      <p>{parsed.error || "The presentation has no slides."}</p>
      <p>Repair the Canvas JSON or restore an earlier version from History.</p>
    </div>;
  }

  return <div className="slides-canvas">
    <div className="office-import-row">
      <button className="btn secondary" type="button" onClick={() => fileInput.current?.click()} disabled={disabled || importing}>
        {importing ? "Importing…" : "Import PPTX"}
      </button>
      <input ref={fileInput} className="office-file-input" type="file" accept=".pptx" aria-label="Import PPTX presentation" onChange={(event) => void handleImport(event.target.files?.[0])} />
      <span className="office-import-note">Canvas imports editable text and positions; presentation styling and media are not retained.</span>
    </div>
    {status && <p className="office-status" role="status">{status}</p>}
    <div className="slides-toolbar">
      <label>Slide
        <select value={slideIndex} onChange={(event) => { setSlideIndex(Number(event.target.value)); setSelectedId(null); }} disabled={disabled}>
          {model.slides.map((_, index) => <option key={index} value={index}>Slide {index + 1}</option>)}
        </select>
      </label>
      <button className="btn secondary" type="button" disabled={disabled || model.slides.length >= 100} onClick={() => {
        updateModel((current) => ({ ...current, slides: [...current.slides, { background: "FFFFFF", elements: [] }] }));
        setSlideIndex(model.slides.length);
        setSelectedId(null);
      }}>Add slide</button>
      <button className="btn secondary" type="button" disabled={disabled || slide.elements.length >= 100} onClick={() => {
        const element: SlideElement = {
          id: createId(),
          text: "New text",
          x: model.width * 0.1,
          y: model.height * 0.1,
          w: Math.min(5, model.width * 0.8),
          h: Math.min(0.8, model.height * 0.8),
          fontSize: 24,
          color: "18242B",
          bold: false,
          align: "left",
        };
        updateModel((current) => ({
          ...current,
          slides: current.slides.map((item, index) => index === slideIndex ? { ...item, elements: [...item.elements, element] } : item),
        }));
        setSelectedId(element.id);
      }}>Add text</button>
      <span>{model.width.toFixed(2)} × {model.height.toFixed(2)} in</span>
    </div>
    <div className="slide-format-toolbar" aria-label="Slide formatting">
      <label>Background<input type="color" value={`#${slide.background.replace(/^#/, "")}`} disabled={disabled} onChange={(event) => updateModel((current) => ({
        ...current,
        slides: current.slides.map((item, index) => index === slideIndex ? { ...item, background: event.target.value.slice(1).toUpperCase() } : item),
      }))} /></label>
      {selected ? <>
        <label>Size<input type="number" min="8" max="96" value={selected.fontSize} disabled={disabled} onChange={(event) => updateElement((element) => ({ ...element, fontSize: Math.min(96, Math.max(8, Number(event.target.value) || 8)) }))} /></label>
        <label>Text color<input type="color" value={`#${selected.color.replace(/^#/, "")}`} disabled={disabled} onChange={(event) => updateElement((element) => ({ ...element, color: event.target.value.slice(1).toUpperCase() }))} /></label>
        <label>Align<select value={selected.align} disabled={disabled} onChange={(event) => updateElement((element) => ({ ...element, align: event.target.value as SlideElement["align"] }))}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </select></label>
        <button className="btn secondary slide-bold-button" type="button" aria-label="Bold" aria-pressed={selected.bold} disabled={disabled} onClick={() => updateElement((element) => ({ ...element, bold: !element.bold }))}>B</button>
        <button className="btn secondary" type="button" disabled={disabled} onClick={() => {
          updateModel((current) => ({
            ...current,
            slides: current.slides.map((item, index) => index === slideIndex
              ? { ...item, elements: item.elements.filter((element) => element.id !== selected.id) }
              : item),
          }));
          setSelectedId(null);
        }}>Delete text</button>
      </> : <span>Select text to format it.</span>}
    </div>
    <div className="slides-workspace">
      <div className="slide-stage-wrap">
        <div ref={stageRef} className="slide-stage" style={{ aspectRatio: `${model.width} / ${model.height}`, width: `min(100%, calc(100cqh * ${model.width / model.height}))`, backgroundColor: `#${slide.background.replace(/^#/, "")}` }} aria-label={`Slide ${slideIndex + 1} editor`}>
          {slide.elements.map((element) => <div key={element.id} className={`slide-text-shape${selectedId === element.id ? " selected" : ""}`} style={{
            left: `${element.x / model.width * 100}%`,
            top: `${element.y / model.height * 100}%`,
            width: `${element.w / model.width * 100}%`,
            height: `${element.h / model.height * 100}%`,
            color: `#${element.color.replace(/^#/, "")}`,
            fontSize: `${element.fontSize * 100 / 72 / model.width}cqw`,
            fontWeight: element.bold ? 700 : 400,
            textAlign: element.align,
            ...(element.fill ? { backgroundColor: `#${element.fill.replace(/^#/, "")}` } : {}),
          }}>
            <textarea aria-label={`Edit slide text: ${element.text.slice(0, 60) || "empty text"}`} value={element.text} maxLength={5000} disabled={disabled}
              onFocus={() => setSelectedId(element.id)}
              onChange={(event) => {
                const text = event.target.value;
                updateModel((current) => ({
                  ...current,
                  slides: current.slides.map((item, index) => index === slideIndex
                    ? { ...item, elements: item.elements.map((entry) => entry.id === element.id ? { ...entry, text } : entry) }
                    : item),
                }));
              }} />
            {selectedId === element.id && !disabled && <>
              <button type="button" className="slide-move-handle" aria-label="Move text box" title="Drag to move; arrow keys move by 0.1 inches" onPointerDown={(event) => startGesture(event, "move")} onPointerMove={moveGesture} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onKeyDown={(event) => keyboardGeometry(event, "move")}>Move</button>
              <button type="button" className="slide-resize-handle" aria-label="Resize text box" title="Drag to resize; arrow keys resize by 0.1 inches" onPointerDown={(event) => startGesture(event, "resize")} onPointerMove={moveGesture} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onKeyDown={(event) => keyboardGeometry(event, "resize")} />
            </>}
          </div>)}
        </div>
      </div>
    </div>
    <p className="slide-edit-hint">Click text to edit. Use the handles to move or resize it.</p>
  </div>;
}
