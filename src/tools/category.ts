import { z } from "zod";
import { assertTableName, createDataTable, db, META_TABLE } from "../db.js";
import { now } from "../utils/date.js";
import { readMeta } from "./meta.js";
import type { ToolDef } from "./index.js";

const createCategory: ToolDef = {
  name: "create_category",
  config: {
    description:
      "Create a new collection (table) and register it in _meta. Call list_collections or find_relevant_collections first — reuse an existing collection when one fits. " +
      "The description decides whether this collection is ever found again, so write it concretely and cover all three: " +
      "(1) what this records, (2) what questions it answers, (3) related synonyms and alternative phrasings. " +
      "Korean descriptions and keywords are expected.",
    inputSchema: {
      collection_name: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/, "lowercase letters, digits and underscores; must start with a letter")
        .describe("Table name, e.g. 'meals', 'workout', 'travel_plans'"),
      description: z
        .string()
        .min(10)
        .describe("What this records / what questions it answers / related synonyms — concretely, in Korean"),
      category_group: z.string().min(1).describe("Broad group, e.g. 'food', 'health', 'plan'"),
      keywords: z.array(z.string().min(1)).min(1).describe("Search keywords including synonyms, e.g. ['식사','밥','칼로리']"),
      sample_fields: z.array(z.string().min(1)).optional().describe("Field names the records will use, e.g. ['date','food']"),
    },
  },
  run: async ({
    collection_name,
    description,
    category_group,
    keywords,
    sample_fields,
  }: {
    collection_name: string;
    description: string;
    category_group: string;
    keywords: string[];
    sample_fields?: string[];
  }) => {
    assertTableName(collection_name);

    const existing = (await readMeta()).find((entry) => entry.collection_name === collection_name);
    if (existing) {
      return {
        created: false,
        reason: "already exists — reuse it with insert_record",
        collection: existing,
      };
    }

    const timestamp = now();
    await createDataTable(collection_name);
    await db.execute({
      sql: `INSERT INTO ${META_TABLE}
              (collection_name, description, category_group, keywords, sample_fields, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        collection_name,
        description,
        category_group,
        JSON.stringify(keywords),
        JSON.stringify(sample_fields ?? []),
        timestamp,
        timestamp,
      ],
    });

    return {
      created: true,
      collection: {
        collection_name,
        description,
        category_group,
        keywords,
        sample_fields: sample_fields ?? [],
        created_at: timestamp,
        updated_at: timestamp,
      },
    };
  },
};

export const categoryTools: ToolDef[] = [createCategory];
