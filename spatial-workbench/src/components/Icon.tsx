/**
 * Shared line-icon set for AI Workbench.
 *
 * Every icon is drawn in the same visual language as the left taskbar
 * (`.activity-btn`): a 24×24 viewBox, `fill="none"`, `stroke="currentColor"`,
 * `strokeWidth 1.8`, and round line caps/joins. Using one component keeps the
 * whole site's iconography consistent instead of mixing emoji/unicode glyphs.
 */

export type IconName =
  | "hexagon"
  | "bolt"
  | "board"
  | "file"
  | "image"
  | "upload"
  | "globe"
  | "note"
  | "check"
  | "ban"
  | "x"
  | "gear"
  | "chevron-down"
  | "chevron-right"
  | "folder"
  | "folder-open"
  | "trash"
  | "download"
  | "copy"
  | "refresh"
  | "audio"
  | "video"
  | "help"
  | "search"
  | "arrow-left"
  | "arrow-right"
  | "microphone"
  | "speaker"
  | "play"
  | "stop";

const PATHS: Record<IconName, string[]> = {
  hexagon: ["M12 3 L19.8 7.5 V16.5 L12 21 L4.2 16.5 V7.5 Z"],
  bolt: ["M13 2 L4 14 H10 L9 22 L20 9 H13 Z"],
  // Reuses the taskbar "board" glyph so the two always match.
  board: ["M4 4h16v16H4V4Zm4 4h3v3H8V8Zm5 5h3v3h-3v-3Z"],
  file: ["M6 2 H14 L18 6 V22 H6 Z", "M14 2 V6 H18"],
  image: ["M3 5 H21 V19 H3 Z", "M3 16 l5-5 4 4 3-3 6 6", "M15.5 8 a1.5 1.5 0 1 0 0 3 a1.5 1.5 0 1 0 0 -3"],
  upload: ["M12 16 V4", "M7 9 l5-5 5 5", "M4 16 V20 H20 V16"],
  globe: [
    "M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18",
    "M12 3 c-2.6 2.6 -2.6 15.4 0 18",
    "M12 3 c2.6 2.6 2.6 15.4 0 18",
    "M3 12 H21",
  ],
  note: ["M6 2 H18 V22 H6 Z", "M9 7 H15", "M9 11 H15", "M9 15 H13"],
  check: ["M5 13 l4 4 L19 7"],
  ban: ["M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18", "M5.6 5.6 L18.4 18.4"],
  x: ["M6 6 L18 18", "M18 6 L6 18"],
  gear: [
    "M19.4 15 a1.65 1.65 0 0 0 .33 1.82 l.06.06 a2 2 0 1 1-2.83 2.83 l-.06-.06 a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51 V21 a2 2 0 0 1-4 0 v-.09 A1.65 1.65 0 0 0 9 19.4 a1.65 1.65 0 0 0-1.82.33 l-.06.06 a2 2 0 1 1-2.83-2.83 l.06-.06 a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1 H3 a2 2 0 0 1 0-4 h.09 A1.65 1.65 0 0 0 4.6 9 a1.65 1.65 0 0 0-.33-1.82 l-.06-.06 a2 2 0 1 1 2.83-2.83 l.06.06 a1.65 1.65 0 0 0 1.82.33 H9 a1.65 1.65 0 0 0 1-1.51 V3 a2 2 0 0 1 4 0 v.09 a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33 l.06-.06 a2 2 0 1 1 2.83 2.83 l-.06.06 a1.65 1.65 0 0 0-.33 1.82 V9 a1.65 1.65 0 0 0 1.51 1 H21 a2 2 0 0 1 0 4 h-.09 a1.65 1.65 0 0 0-1.51 1 z",
    "M12 15 a3 3 0 1 0 0-6 a3 3 0 1 0 0 6",
  ],
  "chevron-down": ["M6 9 l6 6 6-6"],
  "chevron-right": ["M9 6 l6 6-6 6"],
  folder: ["M3 6 H10 L12 8 H21 V19 H3 Z"],
  "folder-open": ["M3 6 H10 L12 8 H21 V12", "M2 18 L5 11 H22 L19 18 Z"],
  trash: ["M4 7 H20", "M10 4 H14", "M6 7 L7 21 H17 L18 7", "M10 11 V17", "M14 11 V17"],
  download: ["M12 4 V16", "M7 11 l5 5 5-5", "M4 20 H20"],
  copy: ["M9 9 H21 V21 H9 Z", "M15 9 V3 H3 V15 H9"],
  refresh: ["M20 7 V3 L16 7 H20", "M20 7 A8 8 0 1 0 20 17"],
  audio: ["M12 3 A3 3 0 0 0 9 6 V12 A3 3 0 0 0 15 12 V6 A3 3 0 0 0 12 3", "M5 10 V12 A7 7 0 0 0 19 12 V10", "M12 19 V22"],
  video: ["M3 5 H16 V19 H3 Z", "M16 10 L22 6 V18 L16 14"],
  help: ["M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18", "M9.5 9 a2.5 2.5 0 1 1 4 2 l-1.5 1 V14", "M12 17 h.01"],
  search: ["M10.5 3 a7.5 7.5 0 1 0 0 15 a7.5 7.5 0 1 0 0 -15", "M16 16 L21 21"],
  "arrow-left": ["M19 12 H5", "M11 6 L5 12 L11 18"],
  "arrow-right": ["M5 12 H19", "M13 6 L19 12 L13 18"],
  microphone: ["M12 3 A3 3 0 0 0 9 6 V12 A3 3 0 0 0 15 12 V6 A3 3 0 0 0 12 3", "M5 10 V12 A7 7 0 0 0 19 12 V10", "M12 19 V22", "M8 22 H16"],
  speaker: ["M4 10 V14 H8 L13 18 V6 L8 10 Z", "M17 9 A5 5 0 0 1 17 15", "M19 6 A9 9 0 0 1 19 18"],
  play: ["M7 4 L20 12 L7 20 Z"],
  stop: ["M6 6 H18 V18 H6 Z"],
};

interface IconProps {
  name: IconName;
  /** Pixel size for both width and height. Defaults to 16. */
  size?: number;
  className?: string;
  /** Override the stroke width (defaults to the taskbar's 1.8). */
  strokeWidth?: number;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
