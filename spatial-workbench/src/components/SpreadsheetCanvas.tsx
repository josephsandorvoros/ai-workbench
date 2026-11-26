import { useEffect, useMemo, useRef, useState } from "react";
import {
  cellAddress,
  columnName,
  importXlsx,
  parseSpreadsheetModel,
  readCellInput,
  type OfficeCell,
  type SpreadsheetModel,
} from "../office/officeCanvas";

const ROWS_PER_PAGE = 30;
const COLUMNS_PER_PAGE = 16;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 16_384;

function cellText(cell: OfficeCell | undefined): string {
  if (!cell) return "";
  if (cell.formula) return cell.result == null ? cell.formula : String(cell.result);
  return cell.value == null ? "" : String(cell.value);
}

function selectedCellText(cell: OfficeCell | undefined): string {
  return cell?.formula ?? (cell?.value == null ? "" : String(cell.value));
}

function modelCellCount(model: SpreadsheetModel): number {
  return model.sheets.reduce((total, sheet) => total + Object.keys(sheet.cells).length, 0);
}

export function SpreadsheetCanvas({ content, onChange, disabled }: {
  content: string;
  onChange: (content: string) => void;
  disabled: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => {
    try {
      return { model: parseSpreadsheetModel(content), error: "" };
    } catch (reason) {
      return { model: null, error: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [content]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const [selectedAddress, setSelectedAddress] = useState("A1");
  const [formulaDraft, setFormulaDraft] = useState("");
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [importing, setImporting] = useState(false);
  const model = parsed.model;
  const sheet = model?.sheets[sheetIndex] ?? model?.sheets[0];
  const selectedCell = sheet?.cells[selectedAddress];
  const firstRow = rowPage * ROWS_PER_PAGE;
  const firstColumn = columnPage * COLUMNS_PER_PAGE;

  useEffect(() => {
    setSheetIndex((current) => Math.min(current, Math.max(0, (parsed.model?.sheets.length ?? 1) - 1)));
    setCellDrafts({});
  }, [content, parsed.model?.sheets.length]);

  useEffect(() => {
    setFormulaDraft(selectedCellText(selectedCell));
  }, [selectedAddress, sheetIndex, selectedCell?.formula, selectedCell?.value, selectedCell?.result]);

  function updateModel(transform: (current: SpreadsheetModel) => SpreadsheetModel) {
    if (!model || disabled) return;
    const updated = transform(model);
    onChange(JSON.stringify(updated));
    setStatus("");
  }

  function commitCell(address: string, value: string) {
    if (!model || !sheet || disabled) return;
    const nextCell = readCellInput(value);
    updateModel((current) => {
      return {
        ...current,
        sheets: current.sheets.map((item, index) => index === sheetIndex
          ? { ...item, cells: { ...item.cells, [address]: nextCell } }
          : item),
      };
    });
    setCellDrafts((current) => {
      const next = { ...current };
      delete next[address];
      return next;
    });
    setFormulaDraft(selectedCellText(nextCell));
  }

  async function handleImport(file?: File) {
    if (!file) return;
    setImporting(true);
    setStatus("");
    try {
      const imported = await importXlsx(file);
      onChange(JSON.stringify(imported));
      setSheetIndex(0);
      setRowPage(0);
      setColumnPage(0);
      setSelectedAddress("A1");
      setStatus("Imported cell values and formulas. Formatting, charts, macros, and other workbook features are not retained.");
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!model || !sheet) {
    return <div className="office-canvas-error" role="alert">
      <strong>Canvas spreadsheet data cannot be opened.</strong>
      <p>{parsed.error || "The workbook has no sheets."}</p>
      <p>Repair the Canvas JSON or restore an earlier version from History.</p>
    </div>;
  }

  return <div className="spreadsheet-canvas">
    <div className="office-import-row">
      <button className="btn secondary" type="button" onClick={() => fileInput.current?.click()} disabled={disabled || importing}>
        {importing ? "Importing…" : "Import XLSX"}
      </button>
      <input ref={fileInput} className="office-file-input" type="file" accept=".xlsx" aria-label="Import XLSX workbook" onChange={(event) => void handleImport(event.target.files?.[0])} />
      <span className="office-import-note">Canvas preserves cell values and formulas; Excel formatting, charts, and macros are not imported.</span>
    </div>
    {status && <p className="office-status" role="status">{status}</p>}
    <div className="spreadsheet-controls">
      <label>Sheet
        <select value={sheetIndex} onChange={(event) => { setSheetIndex(Number(event.target.value)); setSelectedAddress("A1"); }} disabled={disabled}>
          {model.sheets.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}
        </select>
      </label>
      <button className="btn secondary" type="button" disabled={disabled || model.sheets.length >= 50} onClick={() => {
        const base = "Sheet";
        const used = new Set(model.sheets.map((item) => item.name));
        let suffix = model.sheets.length + 1;
        while (used.has(`${base}${suffix}`)) suffix += 1;
        updateModel((current) => ({ ...current, sheets: [...current.sheets, { name: `${base}${suffix}`, cells: {} }] }));
        setSheetIndex(model.sheets.length);
        setRowPage(0);
        setColumnPage(0);
      }}>Add sheet</button>
      <span className="spreadsheet-cell-count">{modelCellCount(model).toLocaleString()} populated cells</span>
    </div>
    <div className="spreadsheet-formula-bar">
      <strong aria-label="Selected cell">{selectedAddress}</strong>
      <input aria-label="Cell value or formula" value={formulaDraft} disabled={disabled} onChange={(event) => setFormulaDraft(event.target.value)} onBlur={() => commitCell(selectedAddress, formulaDraft)} onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }} />
    </div>
    <div className="spreadsheet-grid-scroll">
      <table className="spreadsheet-grid" aria-label={`${sheet.name} spreadsheet`}>
        <thead><tr><th aria-label="Row number"></th>{Array.from({ length: COLUMNS_PER_PAGE }, (_, offset) => <th key={offset}>{columnName(firstColumn + offset)}</th>)}</tr></thead>
        <tbody>
          {Array.from({ length: ROWS_PER_PAGE }, (_, rowOffset) => {
            const row = firstRow + rowOffset;
            return <tr key={row}>
              <th>{row + 1}</th>
              {Array.from({ length: COLUMNS_PER_PAGE }, (_, columnOffset) => {
                const address = cellAddress(row, firstColumn + columnOffset);
                return <td key={address} className={selectedAddress === address ? "selected" : undefined}>
                  <input aria-label={`${address} cell`} value={cellDrafts[address] ?? cellText(sheet.cells[address])} disabled={disabled} onFocus={() => setSelectedAddress(address)} onChange={(event) => setCellDrafts((current) => ({ ...current, [address]: event.target.value }))} onBlur={() => {
                    if (Object.hasOwn(cellDrafts, address)) commitCell(address, cellDrafts[address]);
                  }} onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }} />
                </td>;
              })}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <div className="spreadsheet-pagination">
      <div className="spreadsheet-page-group">
        <button className="btn secondary" type="button" aria-label="Previous rows" disabled={rowPage === 0} onClick={() => setRowPage((page) => page - 1)}>←</button>
        <span>Rows {firstRow + 1}–{Math.min(firstRow + ROWS_PER_PAGE, MAX_ROWS)}</span>
        <button className="btn secondary" type="button" aria-label="Next rows" disabled={firstRow + ROWS_PER_PAGE >= MAX_ROWS} onClick={() => setRowPage((page) => page + 1)}>→</button>
      </div>
      <div className="spreadsheet-page-group">
        <button className="btn secondary" type="button" aria-label="Previous columns" disabled={columnPage === 0} onClick={() => setColumnPage((page) => page - 1)}>←</button>
        <span>Columns {columnName(firstColumn)}–{columnName(Math.min(firstColumn + COLUMNS_PER_PAGE - 1, MAX_COLUMNS - 1))}</span>
        <button className="btn secondary" type="button" aria-label="Next columns" disabled={firstColumn + COLUMNS_PER_PAGE >= MAX_COLUMNS} onClick={() => setColumnPage((page) => page + 1)}>→</button>
      </div>
    </div>
    <p className="office-formula-note">Formulas are retained but not recalculated in Canvas. Excel recalculates them when you open the exported workbook.</p>
  </div>;
}
