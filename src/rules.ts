import { db } from "./db.js";

/**
 * Working rules for AI clients live in the database, not in any one client's
 * prompt files, so Claude, Gemini and ChatGPT all get the same ones — through
 * tool responses, the only channel every MCP client reads.
 */
export const RULES_COLLECTION = "ai_rules";

/** user_input: changing it needs confirm. write_once: may be filled while empty, changing it needs confirm. */
export type Enforce = { field: string; mode: "user_input" | "write_once" };

export type Rule = { id: number; scope: string; rule: string; reason?: string; enforce?: Enforce[] };

/** Active rules for these scopes ("global" or a collection name), oldest first. Empty until ai_rules exists. */
export async function readRules(scopes: string[]): Promise<Rule[]> {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) return [];
  try {
    const result = await db.execute({
      sql: `SELECT id, data FROM ${RULES_COLLECTION}
             WHERE json_extract(data, '$.scope') IN (${unique.map(() => "?").join(", ")})
             ORDER BY id`,
      args: unique,
    });
    return result.rows
      .map((row) => ({ id: Number(row.id), ...(JSON.parse(String(row.data)) as Omit<Rule, "id"> & { active?: boolean }) }))
      .filter((rule) => rule.active !== false)
      .map(({ active: _active, ...rule }) => rule);
  } catch (error) {
    if (String(error).includes("no such table")) return [];
    throw error;
  }
}
