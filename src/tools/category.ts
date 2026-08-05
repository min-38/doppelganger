import { z } from "zod";
import { assertTableName, createDataTable, db, ensureFieldIndex, META_TABLE } from "../db.js";
import { isDateField, now } from "../utils/date.js";
import { findSimilarCategories, SIMILARITY_THRESHOLD } from "../utils/score.js";
import { readMeta } from "./meta.js";
import type { ToolDef } from "./index.js";

const createCategory: ToolDef = {
  name: "create_category",
  config: {
    description:
      "Create a new collection (table) and register it in _meta. Call list_collections or find_relevant_collections first — reuse an existing collection when one fits. " +
      "The description decides whether this collection is ever found again, so write it concretely and cover all three: " +
      "(1) what this records, (2) what questions it answers, (3) related synonyms and alternative phrasings. " +
      "Korean descriptions and keywords are expected. " +
      "If a similar collection already exists, creation is refused and the similar ones are returned — reuse one of those instead. " +
      "Only pass force: true when the user confirms the new collection really is different.",
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
      force: z.boolean().optional().describe("Create even though a similar collection exists — only after the user confirms"),
    },
  },
  run: async ({
    collection_name,
    description,
    category_group,
    keywords,
    sample_fields,
    force,
  }: {
    collection_name: string;
    description: string;
    category_group: string;
    keywords: string[];
    sample_fields?: string[];
    force?: boolean;
  }) => {
    assertTableName(collection_name);

    const registry = await readMeta();
    const existing = registry.find((entry) => entry.collection_name === collection_name);
    if (existing) {
      return {
        created: false,
        reason: "already exists — reuse it with insert_record",
        collection: existing,
      };
    }

    const similar = findSimilarCategories(
      { collection_name, description, keywords, category_group },
      registry,
    );
    if (similar.length > 0 && !force) {
      return {
        created: false,
        reason: `a similar collection already exists (similarity >= ${SIMILARITY_THRESHOLD})`,
        similar,
        hint: "Reuse one of these with insert_record, or call again with force: true if it really is a different thing.",
      };
    }

    const timestamp = now();
    await createDataTable(collection_name);
    // date is indexed by createDataTable; index any other date-ish field the
    // category declares up front (start_date, slept_at, ...).
    const indexedFields = ["date"];
    for (const field of sample_fields ?? []) {
      if (field !== "date" && isDateField(field)) {
        await ensureFieldIndex(collection_name, field);
        indexedFields.push(field);
      }
    }
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
      similar,
      indexed_fields: indexedFields,
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
