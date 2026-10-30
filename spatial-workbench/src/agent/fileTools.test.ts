import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FILE_TOOLS } from "./fileTools.ts";

describe("FILE_TOOLS", () => {
  it("covers read, targeted edit, full write, and delete", () => {
    const names = FILE_TOOLS.map((tool) => tool.name);
    assert.deepEqual(names, ["read_code_file", "edit_code_file", "write_code_file", "delete_code_file"]);
  });

  it("declares the required parameters for each tool", () => {
    const required = Object.fromEntries(
      FILE_TOOLS.map((tool) => [tool.name, (tool.parameters as { required?: string[] }).required ?? []]),
    );

    assert.deepEqual(required.read_code_file, ["path"]);
    assert.deepEqual(required.edit_code_file, ["path", "old_string", "new_string"]);
    assert.deepEqual(required.write_code_file, ["path", "contents"]);
    assert.deepEqual(required.delete_code_file, ["path"]);
  });

  it("gives every tool a description", () => {
    for (const tool of FILE_TOOLS) {
      assert.ok(tool.description.length > 0, `${tool.name} has no description`);
    }
  });
});
