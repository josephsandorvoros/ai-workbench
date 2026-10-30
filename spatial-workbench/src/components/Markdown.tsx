import { Children, useMemo, useState, type ReactElement } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkWikilinks } from "../lib/remarkWikilinks";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import dockerfile from "highlight.js/lib/languages/dockerfile";

// Register only the languages we actually render — keeps the bundle small.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("dockerfile", dockerfile);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    // Clipboard API can be unavailable (non-secure context) — fall back.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch (_fallbackError) {
      return false;
    }
  }
}

/**
 * A fenced code block: language label + copy button header, syntax
 * highlighting via highlight.js (VS Code chat style).
 */
function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language }).value;
      } catch (_error) {
        return escapeHtml(code);
      }
    }
    return escapeHtml(code);
  }, [code, language]);

  async function handleCopy() {
    if (await copyText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || "code"}</span>
        <button className="code-block-copy" type="button" onClick={() => void handleCopy()}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block-pre">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

/**
 * Render content as Markdown with GFM tables, lists, and highlighted code
 * blocks. Plain text without markdown syntax renders identically to before.
 *
 * Obsidian-style `[[wikilinks]]` are parsed by the `remarkWikilinks` plugin
 * into links with a `wiki://` URL. When `onWikiLinkClick` is provided they
 * render as clickable buttons that invoke the callback with the decoded link
 * target; otherwise they render as plain text.
 */
export function Markdown({
  content,
  onWikiLinkClick,
  onHelpLinkClick,
}: {
  content: string;
  onWikiLinkClick?: (target: string) => void;
  onHelpLinkClick?: (href: string) => void;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikilinks]}
        urlTransform={(value) =>
          value.startsWith("wiki://") ? value : defaultUrlTransform(value)
        }
        components={{
          // Block code: intercept <pre> so we can add the header + copy button.
          pre({ children }) {
            const child = Children.only(children) as ReactElement<{
              className?: string;
              children?: React.ReactNode;
            }>;
            const match = /language-([\w+-]+)/.exec(child.props.className || "");
            const code = String(child.props.children ?? "").replace(/\n$/, "");
            return <CodeBlock language={match?.[1]} code={code} />;
          },
          // Inline code (block code is handled by `pre` above).
          code(props) {
            return <code className="md-inline-code">{props.children}</code>;
          },
          a(props) {
            const href = props.href || "";
            let previewUrl: URL | null = null;
            try {
              const candidate = new URL(href, window.location.href);
              if (candidate.origin === window.location.origin
                && candidate.searchParams.get("tab") === "project"
                && candidate.searchParams.has("preview")) previewUrl = candidate;
            } catch {}
            if (href.startsWith("#help/") && onHelpLinkClick) {
              return <a href={href} onClick={(event) => { event.preventDefault(); onHelpLinkClick(href); }}>{props.children}</a>;
            }
            if (href.startsWith("wiki://")) {
              const target = decodeURIComponent(href.slice("wiki://".length));
              if (!onWikiLinkClick) {
                return <span className="md-wikilink-static">[[{target}]]</span>;
              }
              return (
                <button
                  type="button"
                  className="md-wikilink"
                  onClick={() => onWikiLinkClick(target)}
                  title={`Open wiki page: ${target}`}
                >
                  {props.children}
                </button>
              );
            }
            return (
              <a
                {...props}
                target={previewUrl ? "_self" : "_blank"}
                rel={previewUrl ? undefined : "noopener noreferrer"}
                onClick={previewUrl ? (event) => {
                  event.preventDefault();
                  window.open(previewUrl.toString(), "_blank");
                } : undefined}
              >
                {props.children}
              </a>
            );
          },
          table(props) {
            return (
              <div className="md-table-wrap">
                <table {...props} />
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
