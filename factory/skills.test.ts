import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The skills the loop runs headless; each must end with the result report the loop parses. */
const SKILLS = ["cook", "taste_test", "remake"] as const;

function readSkill(name: string): string {
  return readFileSync(join(import.meta.dir, "skills", name, "SKILL.md"), "utf8");
}

/** Text of the `## Result` section, up to the next `## ` heading or the end of the file. */
function resultSection(text: string): string | null {
  const match = text.match(/^## Result\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  return match?.[1] ?? null;
}

describe.each(SKILLS)("%s skill", (name) => {
  const text = readSkill(name);

  test("has a Result section naming both outcomes and a reason for skipped", () => {
    const section = resultSection(text);
    expect(section).not.toBeNull();
    expect(section).toMatch(/processed/i);
    expect(section).toMatch(/skipped/i);
    expect(section).toMatch(/one-sentence reason/i);
  });

  test("asks for no result file and no hand-written JSON", () => {
    expect(text).not.toMatch(/result file/i);
    expect(resultSection(text) ?? "").not.toMatch(/json/i);
  });
});

/** The dependency skills, and who must hand off to whom. */
const DEP_SKILLS = ["task-pair-check", "task-determine-deps", "task-update-deps"] as const;

describe("dependency skills", () => {
  test.each(DEP_SKILLS)("%s exists with a matching name and a description", (name) => {
    const text = readSkill(name);
    expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n`));
  });

  test("the judging skill never writes; the other two reach the task file only through the deps command", () => {
    expect(readSkill("task-pair-check")).toMatch(/Never edit any file/);
    for (const name of ["task-determine-deps", "task-update-deps"] as const) {
      const text = readSkill(name);
      expect(text).toContain("../task-pair-check/SKILL.md");
      expect(text).toContain("bun factory/deps-cli.ts candidates");
      expect(text).toMatch(/Never decide whether (a|the) task may run/);
    }
    expect(readSkill("task-update-deps")).toContain("bun factory/deps-cli.ts set");
  });

  test("take_order, to_tasks and customize_order hand dependencies to them", () => {
    expect(readSkill("to_tasks")).toContain("../task-determine-deps/SKILL.md");
    expect(readSkill("customize_order")).toContain("../task-update-deps/SKILL.md");
    const takeOrder = readSkill("take_order");
    expect(takeOrder.indexOf("**Pick the project.**")).toBeLessThan(takeOrder.indexOf("**Break down.**"));
    expect(takeOrder).toContain("dependencyReasons");
  });
});
