import type { MentionItem } from "../agent/toolCallSummary";
import { Icon, type IconName } from "./Icon";

interface MentionMenuProps {
  items: MentionItem[];
  index: number;
  onHover: (index: number) => void;
  onSelect: (item: MentionItem) => void;
}

const MENTION_ICONS: Record<MentionItem["kind"], IconName> = {
  board: "board",
  file: "file",
  web: "globe",
  note: "note",
  upload: "upload",
  image: "image",
};

function mentionIcon(kind: MentionItem["kind"]): IconName {
  return MENTION_ICONS[kind] ?? "note";
}

/**
 * The @-mention context menu (VS Code style): pops up above the input when
 * the user types "@", listing board/file/web/note context they can attach.
 */
export function MentionMenu({ items, index, onHover, onSelect }: MentionMenuProps) {
  return (
    <div className="mention-menu" role="listbox" aria-label="Attach context">
      {items.map((item, i) => (
        <button
          key={`${item.kind}-${item.label}`}
          className={`mention-menu-item ${item.kind} ${i === index ? "active" : ""}`}
          type="button"
          role="option"
          aria-selected={i === index}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(item)}
        >
          <span className="mention-menu-icon" aria-hidden>
            <Icon name={mentionIcon(item.kind)} size={15} />
          </span>
          <span className="mention-menu-main">
            <span className="mention-menu-label">{item.label}</span>
            <span className="mention-menu-desc">{item.description}</span>
          </span>
        </button>
      ))}
      <div className="mention-menu-hint">↑↓ navigate · Tab/Enter attach · Esc close</div>
    </div>
  );
}
