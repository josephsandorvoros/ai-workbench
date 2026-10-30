import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HELP_GROUPS, HELP_TOPICS, helpLinkTarget, searchHelp, type HelpArticle } from "./helpCatalog.ts";

const articles: HelpArticle[] = HELP_TOPICS.map((topic) => ({ ...topic, content: topic.id === "security" ? "Workers cannot reach a private network without SANDBOX_ALLOW_LAN exceptions." : "" }));

test("help topics have unique IDs and known groups", () => {
  assert.equal(new Set(HELP_TOPICS.map((topic) => topic.id)).size, HELP_TOPICS.length);
  assert.ok(HELP_TOPICS.every((topic) => HELP_GROUPS.includes(topic.group) && topic.title && topic.summary));
});

test("search covers titles, keywords, and article content", () => {
  assert.equal(searchHelp(articles, "wiki")[0].id, "wiki");
  assert.ok(searchHelp(articles, "  API KEY ").some((article) => article.id === "connections"));
  assert.deepEqual(searchHelp(articles, "private network").map((article) => article.id), ["security"]);
  assert.equal(searchHelp(articles, "").length, HELP_TOPICS.length);
  assert.equal(searchHelp(articles, "nonexistent-word-1234").length, 0);
  assert.ok(searchHelp(articles, "live preview").some((article) => article.id === "projects"));
  assert.ok(searchHelp(articles, "managed updates").some((article) => article.id === "maintenance"));
});

test("internal help links resolve only known pages", () => {
  assert.equal(helpLinkTarget("#help/jobs"), "jobs");
  assert.equal(helpLinkTarget("#help/missing"), null);
  assert.equal(helpLinkTarget("https://example.com"), null);
  assert.equal(helpLinkTarget("javascript:alert(1)"), null);
});

test("every guide is bundled from a real source and internal links resolve", () => {
  for (const topic of HELP_TOPICS) {
    const path = topic.id === "deployment-reference" ? "../../../deploy/README.md" : `./pages/${topic.id}.md`;
    const content = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.ok(content.trim().length > 200, `${topic.id} must contain a useful guide`);
    assert.doesNotMatch(content, /^#{2,3} (?:Build and publish|Image publishing and runner storage)/mi, `${topic.id} must not include maintainer-only sections`);
    for (const match of content.matchAll(/\]\((#help\/[^)]+)\)/g)) {
      assert.ok(helpLinkTarget(match[1]), `${topic.id}: broken link ${match[1]}`);
    }
  }
});