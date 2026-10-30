import type { PhrasingContent, Root, RootContent, Text } from "mdast";

type AnyNode = RootContent | PhrasingContent;

/**
 * A remark plugin that converts Obsidian-style `[[wikilinks]]` into standard
 * markdown link nodes carrying a `wiki://` URL.
 *
 * The wiki is plain markdown, but pages cross-reference each other with
 * `[[wikilinks]]`. Turning them into real links lets the `Markdown` component
 * render them as clickable buttons (via its `a` override) and resolve them to
 * actual wiki files through the companion API — no Obsidian tooling required.
 *
 *   [[target]]          -> link "target"
 *   [[target|alias]]    -> link "target", label "alias"
 *   [[target#Heading]]  -> link "target#Heading" (anchor kept; resolver strips it)
 *   [[#Heading]]        -> in-page anchor, left as plain text
 *
 * Wikilinks inside code spans / fenced code blocks are left untouched.
 */
export function remarkWikilinks() {
  return (tree: Root) => {
    transformChildren(tree.children as AnyNode[]);
  };
}

const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g;

function transformChildren(children: AnyNode[]): void {
  const out: AnyNode[] = [];
  for (const node of children) {
    if (node.type === "code" || node.type === "inlineCode") {
      out.push(node);
      continue;
    }
    if (node.type === "text") {
      out.push(...splitText(node));
      continue;
    }
    if ("children" in node && Array.isArray(node.children)) {
      transformChildren(node.children as AnyNode[]);
    }
    out.push(node);
  }
  children.length = 0;
  children.push(...out);
}

function splitText(node: Text): AnyNode[] {
  const text = node.value;
  if (!text.includes("[[")) return [node];

  const parts: AnyNode[] = [];
  let last = 0;
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ type: "text", value: text.slice(last, match.index) });
    }
    const raw = match[1].trim();
    if (raw.startsWith("#")) {
      // In-page anchor with no page target — keep as literal text.
      parts.push({ type: "text", value: match[0] });
    } else {
      const target = raw.split("|", 1)[0].trim();
      const label = raw.split("|", 2)[1]?.trim() || target.split("#", 1)[0];
      parts.push({
        type: "link",
        url: `wiki://${encodeURIComponent(target)}`,
        title: null,
        children: [{ type: "text", value: label }],
      });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}
