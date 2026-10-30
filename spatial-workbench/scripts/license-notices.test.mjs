import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkedNotice, localNotices, packageLicense, sourceNoticeHeader } from "./license-notices.mjs";

test("recognizes legacy license metadata without assuming unknown means MIT", () => {
  assert.equal(packageLicense({ licenses: [{ type: "MIT" }] }, {}), "MIT");
  assert.equal(packageLicense({ license: { type: "ISC" } }, {}), "ISC");
  assert.equal(packageLicense({}, {}), null);
});

test("keeps license and third-party notice text intact", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-license-"));
  try {
    writeFileSync(path.join(directory, "LICENSE"), "copyright and permission\n");
    writeFileSync(path.join(directory, "ThirdPartyNotices.txt"), "additional attributions\n");
    const notices = localNotices(directory);
    assert.equal(notices.length, 2);
    assert.equal(notices.find((notice) => notice.file === "ThirdPartyNotices.txt").text, "additional attributions\n");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("does not mistake a README license link for the full license", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-license-"));
  try {
    writeFileSync(path.join(directory, "README.md"), "License: MIT\n");
    assert.deepEqual(localNotices(directory), []);
    writeFileSync(path.join(directory, "README.md"), "Copyright example\nPermission is hereby granted\nTHE SOFTWARE IS PROVIDED\n");
    assert.equal(localNotices(directory).length, 1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("changed upstream text fails closed", () => {
  const text = "reviewed license\n";
  const hash = createHash("sha256").update(text).digest("hex");
  assert.equal(checkedNotice(text, hash, "example"), text);
  assert.throws(() => checkedNotice("different license", hash, "example"), /Upstream license changed/);
});

test("preserves source-header copyright and Zlib conditions without including executable code", () => {
  const text = "'use strict';\n\n// (C) Example authors\n// This notice may not be removed.\n\nconst implementation = 1;\n";
  assert.equal(sourceNoticeHeader(text), "// (C) Example authors\n// This notice may not be removed.");
  assert.equal(sourceNoticeHeader("const implementation = 1;"), null);
});