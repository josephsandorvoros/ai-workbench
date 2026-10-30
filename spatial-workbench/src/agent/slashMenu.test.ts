import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_SLASH_ITEMS,
  buildHelpText,
  buildSkillPrompt,
  buildSkillPromptHeader,
  filterSlashItems,
  parseGatewaySlashCommand,
  parseSlashQuery,
  slashItemMatches,
  type SlashItem,
} from "./slashMenu.ts";

describe("parseGatewaySlashCommand", () => {
  it("forwards Hermes commands, skills and arguments", () => {
    assert.equal(parseGatewaySlashCommand(" /model fav --global "), "/model fav --global");
    assert.equal(parseGatewaySlashCommand("/frontend-design make it dark\nand compact"), "/frontend-design make it dark\nand compact");
    assert.equal(parseGatewaySlashCommand("/help"), "/help");
    assert.equal(parseGatewaySlashCommand("/compress here 2"), "/compress here 2");
  });

  it("keeps Workbench UI commands, menu items and paths local", () => {
    for (const text of ["/new", "/clear", "/STOP", "/provider", "/skill:foo", "/home/user/file is broken", "hello /help", "/"]) {
      assert.equal(parseGatewaySlashCommand(text), null, text);
    }
  });
});

describe("parseSlashQuery", () => {
  it("is inactive for normal messages", () => {
    assert.deepEqual(parseSlashQuery("hello world"), { active: false, token: "" });
    assert.deepEqual(parseSlashQuery(""), { active: false, token: "" });
  });

  it("activates on a leading slash and lowercases the token", () => {
    assert.deepEqual(parseSlashQuery("/SK"), { active: true, token: "sk" });
    assert.deepEqual(parseSlashQuery("/"), { active: true, token: "" });
  });

  it("deactivates once a space appears (message mode)", () => {
    assert.deepEqual(parseSlashQuery("/skill:foo bar"), { active: false, token: "" });
    assert.deepEqual(parseSlashQuery("  /help "), { active: false, token: "" });
  });
});

describe("filterSlashItems", () => {
  const items: SlashItem[] = [
    ...BUILTIN_SLASH_ITEMS,
    { kind: "skill", label: "/skill:frontend-design", description: "Design UI/UX", skillName: "frontend-design" },
    { kind: "skill", label: "/skill:doc-coauthoring", description: "Docs workflow", skillName: "doc-coauthoring" },
    { kind: "model", label: "/model:qwen3.8-27b", description: "Switch model", modelName: "qwen3.8-27b" },
  ];

  it("returns nothing when the query is inactive", () => {
    assert.deepEqual(filterSlashItems({ active: false, token: "" }, items), []);
  });


  it("includes the Hermes gateway diagnostics commands", () => {
    for (const command of ["/usage", "/status", "/context"]) {
      assert.ok(BUILTIN_SLASH_ITEMS.some((item) => item.label === command));
    }
  });
  it("matches the token as a substring, case-insensitively", () => {
    const matches = filterSlashItems({ active: true, token: "front" }, items);
    assert.deepEqual(
      matches.map((item) => item.label),
      ["/skill:frontend-design"],
    );
  });

  it("does not match the kind prefix for plain tokens", () => {
    // "/sk" must NOT match every /skill:* item via the "skill" prefix.
    const matches = filterSlashItems({ active: true, token: "sk" }, items);
    assert.deepEqual(matches, []);
  });

  it("matches the kind prefix exactly", () => {
    const matches = filterSlashItems({ active: true, token: "skill" }, items);
    assert.deepEqual(
      matches.map((item) => item.label),
      ["/skill:frontend-design", "/skill:doc-coauthoring"],
    );
  });

  it("matches the full label when the token contains a colon", () => {
    const matches = filterSlashItems({ active: true, token: "skill:doc" }, items);
    assert.deepEqual(
      matches.map((item) => item.label),
      ["/skill:doc-coauthoring"],
    );
  });

  it("lists everything for an empty token and respects the limit", () => {
    const all = filterSlashItems({ active: true, token: "" }, items);
    assert.equal(all.length, items.length);
    assert.equal(filterSlashItems({ active: true, token: "" }, items, 3).length, 3);
  });
});

describe("slashItemMatches", () => {
  const skill: SlashItem = { kind: "skill", label: "/skill:frontend-design", description: "" };
  const command: SlashItem = { kind: "command", label: "/help", description: "" };

  it("matches plain commands by label substring", () => {
    assert.equal(slashItemMatches(command, "hel"), true);
    assert.equal(slashItemMatches(command, "clear"), false);
  });

  it("matches skill names after the colon", () => {
    assert.equal(slashItemMatches(skill, "front"), true);
    assert.equal(slashItemMatches(skill, "skill"), true);
    assert.equal(slashItemMatches(skill, "sk"), false);
  });
});

describe("skill prompts", () => {
  const skill = {
    name: "frontend-design",
    description: "Design UI/UX for web apps",
    path: "/home/user/.hermes/skills/frontend-design/SKILL.md",
    source: "hermes" as const,
  };

  it("builds an editable header for the input", () => {
    assert.equal(
      buildSkillPromptHeader(skill),
      'Use the "frontend-design" skill (/home/user/.hermes/skills/frontend-design/SKILL.md). ',
    );
  });

  it("builds a full prompt with the task", () => {
    const prompt = buildSkillPrompt(skill, "Make the board dark");
    assert.match(prompt, /Use the "frontend-design" skill/);
    assert.match(prompt, /Skill summary: Design UI\/UX for web apps/);
    assert.match(prompt, /Make the board dark/);
  });

  it("falls back to a generic instruction without a task", () => {
    assert.match(buildSkillPrompt(skill, "   "), /Follow the skill's instructions/);
  });
});

describe("buildHelpText", () => {
  it("lists built-in commands and mentions the menu", () => {
    const help = buildHelpText();
    for (const item of BUILTIN_SLASH_ITEMS) {
      assert.match(help, new RegExp(item.label));
    }
    assert.match(help, /skills/);
    assert.match(help, /profiles/);
    assert.match(help, /models/);
  });
});
