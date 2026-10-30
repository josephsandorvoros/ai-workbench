import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WIKI_TOOLS } from "./wikiTools.ts";

describe("WIKI_TOOLS", () => {
  it("covers search, read, targeted edit, and full write", () => {
    const names = WIKI_TOOLS.map((tool) => tool.name);
    assert.deepEqual(names, ["search_wiki", "read_wiki_file", "edit_wiki_file", "write_wiki_file"]);
  });

  it("declares the required parameters for each tool", () => {
    const required = Object.fromEntries(
      WIKI_TOOLS.map((tool) => [tool.name, (tool.parameters as { required?: string[] }).required ?? []]),
    );

    assert.deepEqual(required.search_wiki, ["query"]);
    assert.deepEqual(required.read_wiki_file, ["path"]);
    assert.deepEqual(required.edit_wiki_file, ["path", "old_string", "new_string"]);
    assert.deepEqual(required.write_wiki_file, ["path", "content"]);
  });
});
