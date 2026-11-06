import { readFileSync } from "node:fs";

const DIR = new URL("../prompts/", import.meta.url);
const loaded = new Map<string, string>();

export type Vars = Record<string, string | number>;

/**
 * prose returns prompts/<name>.md with each {{key}} replaced by vars[key]. A value is
 * inserted as is and never expanded again, so text from a pull request cannot add one.
 */
export function prose(name: string, vars: Vars = {}): string {
  let text = loaded.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`${name}.md`, DIR), "utf8").trimEnd();
    loaded.set(name, text);
  }
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`prompts/${name}.md needs a value for {{${key}}}`);
    return String(vars[key]);
  });
}

/** block is prose as lines, with the blank line that ends a step. */
export const block = (name: string, vars?: Vars): string[] => [...prose(name, vars).split("\n"), ""];
