import { useEffect, useRef, useState } from "react";
import deploymentGuide from "../../../deploy/README.md?raw";
import { HELP_GROUPS, HELP_TOPICS, helpLinkTarget, searchHelp, type HelpArticle } from "../help/helpCatalog";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const guides = import.meta.glob<string>("../help/pages/*.md", { eager: true, query: "?raw", import: "default" });
const articles: HelpArticle[] = HELP_TOPICS.map((topic) => ({
  ...topic,
  content: topic.id === "deployment-reference" ? deploymentGuide : guides[`../help/pages/${topic.id}.md`],
}));

export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState({ ids: ["getting-started"], index: 0 });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const selected = articles.find((article) => article.id === history.ids[history.index]) || articles[0];
  const matches = searchHelp(articles, query);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      searchRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      buttonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    readerRef.current?.scrollTo({ top: 0 });
  }, [selected.id, open]);

  function navigate(id: string) {
    if (!HELP_TOPICS.some((topic) => topic.id === id)) return;
    setHistory((current) => current.ids[current.index] === id ? current : {
      ids: [...current.ids.slice(0, current.index + 1), id], index: current.index + 1,
    });
  }

  function goBack() {
    setQuery("");
    setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
  }

  function goForward() {
    setQuery("");
    setHistory((current) => ({ ...current, index: Math.min(current.ids.length - 1, current.index + 1) }));
  }

  function followLink(href: string) {
    const id = helpLinkTarget(href);
    if (id) { setQuery(""); navigate(id); }
  }

  return (
    <div className="help-menu">
      <button className="help-trigger" ref={buttonRef} type="button" title="Help" aria-haspopup="dialog" aria-expanded={open} aria-controls="workbench-help" onClick={() => setOpen(true)}>
        <Icon name="help" size={16} /><span>Help</span>
      </button>
      <dialog ref={dialogRef} id="workbench-help" className="help-dialog" aria-labelledby="workbench-help-title"
        onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        {open && <>
          <header className="help-header">
            <div className="help-heading"><Icon name="help" size={20} /><h2 id="workbench-help-title">AI Workbench help</h2></div>
            <div className="help-header-actions">
              <button className="help-icon-btn" type="button" title="Previous help page" aria-label="Previous help page" disabled={history.index === 0} onClick={goBack}><Icon name="arrow-left" /></button>
              <button className="help-icon-btn" type="button" title="Next help page" aria-label="Next help page" disabled={history.index === history.ids.length - 1} onClick={goForward}><Icon name="arrow-right" /></button>
              <button className="help-icon-btn" type="button" title="Close help" aria-label="Close help" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button>
            </div>
          </header>
          <div className="help-body">
            <aside className="help-sidebar" aria-label="Help topics">
              <div className="help-search">
                <Icon name="search" size={16} />
                <input ref={searchRef} type="search" aria-label="Search help" placeholder="Search help" value={query} onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && matches[0]) { event.preventDefault(); navigate(matches[0].id); readerRef.current?.focus(); } }} />
                {query && <button className="help-icon-btn" type="button" title="Clear help search" aria-label="Clear help search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><Icon name="x" size={14} /></button>}
              </div>
              <div className="help-topic-count" role="status">{query.trim() ? `${matches.length} matching ${matches.length === 1 ? "page" : "pages"}` : `${articles.length} pages`}</div>
              <nav className="help-topic-list" aria-label="Help articles">
                {HELP_GROUPS.map((group) => {
                  const topics = matches.filter((article) => article.group === group);
                  if (!topics.length) return null;
                  return <section key={group} className="help-topic-group" aria-label={group}>
                    <h3>{group}</h3>
                    {topics.map((topic) => <button key={topic.id} className={`help-topic${selected.id === topic.id ? " selected" : ""}`} type="button" aria-current={selected.id === topic.id ? "page" : undefined} onClick={() => navigate(topic.id)}>
                      <span>{topic.title}</span><small>{topic.summary}</small>
                    </button>)}
                  </section>;
                })}
                {!matches.length && <div className="help-empty"><h3>No matching pages</h3><p>Try a model name, a task, or an error message.</p><button className="btn secondary small" type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Show all topics</button></div>}
              </nav>
            </aside>
            <div ref={readerRef} className="help-reader" tabIndex={0} aria-label="Help page">
              <article className="help-article" aria-labelledby="help-article-title">
                <div className="help-article-group">{selected.group}</div>
                <h2 id="help-article-title">{selected.title}</h2>
                <p className="help-article-summary">{selected.summary}</p>
                <Markdown content={selected.content} onHelpLinkClick={followLink} />
              </article>
            </div>
          </div>
          <footer className="help-footer"><span>Included with this installation</span><span aria-live="polite">{selected.title}</span></footer>
        </>}
      </dialog>
    </div>
  );
}