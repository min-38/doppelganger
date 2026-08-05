import { strictEqual, deepStrictEqual } from "node:assert";

export type MetaEntry = {
  collection_name: string;
  description: string;
  category_group: string;
  keywords: string[];
  sample_fields: string[];
  created_at: string;
  updated_at: string;
};

/**
 * Substring matching rather than word matching: Korean queries are written
 * without spaces between the stem and its particle ("식사기록", "밥 먹은거"),
 * so token boundaries are not reliable.
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/i)
    .filter((token) => token.length > 0);
}

/**
 * Weak Korean stem match: conjugated forms rarely share a full substring
 * ("먹을까" vs "먹은거"), but they do share the leading syllable(s).
 * ponytail: first-syllable heuristic, swap in a real stemmer or embeddings
 * if recall gets bad.
 */
function stemHit(token: string, candidate: string): boolean {
  if (token.length < 2 || candidate.length < 2) return false;
  if (!/^[가-힣]+$/.test(token) || !/^[가-힣]+$/.test(candidate)) return false;
  return token[0] === candidate[0];
}

/** Higher is more relevant. 0 means "no signal at all", and is filtered out. */
export function scoreEntry(query: string, entry: MetaEntry): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  const name = entry.collection_name.toLowerCase();
  const group = entry.category_group.toLowerCase();
  const description = entry.description.toLowerCase();
  const descriptionTokens = tokenize(description);
  const keywords = entry.keywords.map((k) => k.toLowerCase());

  let score = 0;
  for (const token of tokens) {
    if (keywords.some((k) => k === token)) score += 5;
    else if (keywords.some((k) => k.includes(token) || token.includes(k))) score += 3;
    else if (keywords.some((k) => stemHit(token, k))) score += 1;
    if (name === token) score += 5;
    else if (name.includes(token) || token.includes(name)) score += 3;
    if (group === token) score += 3;
    else if (group.includes(token)) score += 1;
    if (description.includes(token)) score += 2;
    else if (descriptionTokens.some((word) => stemHit(token, word))) score += 1;
  }
  return score;
}

export function rankEntries(query: string, entries: MetaEntry[], limit = 3) {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(query, entry) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.collection_name.localeCompare(b.entry.collection_name))
    .slice(0, limit);
}

export type CategoryDraft = {
  collection_name: string;
  description: string;
  keywords: string[];
  category_group?: string;
};

function bigrams(value: string): Set<string> {
  const padded = ` ${value.toLowerCase()} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 1; i++) out.add(padded.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * 0..1 similarity between a proposed category and an existing one. Character
 * bigrams catch near-identical names (meals / meal_log); token overlap catches
 * different names describing the same thing (meals / food_log).
 * ponytail: string similarity only — swap in embeddings if it misses synonyms
 * that share no characters.
 */
export function categorySimilarity(draft: CategoryDraft, entry: MetaEntry): number {
  const nameScore = jaccard(bigrams(draft.collection_name), bigrams(entry.collection_name));
  const draftTokens = new Set([
    ...tokenize(draft.collection_name),
    ...draft.keywords.flatMap(tokenize),
    ...tokenize(draft.description),
  ]);
  const entryTokens = new Set([
    ...tokenize(entry.collection_name),
    ...entry.keywords.flatMap(tokenize),
    ...tokenize(entry.description),
  ]);
  const tokenScore = jaccard(draftTokens, entryTokens);
  const keywordScore = jaccard(
    new Set(draft.keywords.map((k) => k.toLowerCase())),
    new Set(entry.keywords.map((k) => k.toLowerCase())),
  );
  return Math.max(nameScore, tokenScore, keywordScore);
}

export const SIMILARITY_THRESHOLD = 0.3;

export function findSimilarCategories(draft: CategoryDraft, entries: MetaEntry[], threshold = SIMILARITY_THRESHOLD) {
  return entries
    .map((entry) => ({ collection: entry, similarity: Number(categorySimilarity(draft, entry).toFixed(3)) }))
    .filter((hit) => hit.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

if (import.meta.main) {
  const eq: typeof strictEqual = strictEqual;
  const deepEq: typeof deepStrictEqual = deepStrictEqual;
  const entry = (over: Partial<MetaEntry>): MetaEntry => ({
    collection_name: "meals",
    description: "식사 시간, 먹은 음식, 칼로리 기록. 다이어트 질문에도 매칭",
    category_group: "food",
    keywords: ["식사", "음식", "밥", "먹은거", "칼로리"],
    sample_fields: ["date", "food"],
    created_at: "2026-08-05 00:00:00",
    updated_at: "2026-08-05 00:00:00",
    ...over,
  });
  const meals = entry({});
  const workout = entry({
    collection_name: "workout",
    description: "운동 종목, 세트, 무게 기록",
    category_group: "health",
    keywords: ["운동", "헬스", "스쿼트", "세트"],
  });

  deepEq(tokenize("오늘 뭐 먹을까?"), ["오늘", "뭐", "먹을까"]);
  eq(scoreEntry("스쿼트 3세트 했어", workout) > 0, true);
  eq(scoreEntry("스쿼트 3세트 했어", meals), 0);
  eq(scoreEntry("식사", meals) > scoreEntry("식사", workout), true);
  eq(scoreEntry("칼로리 얼마나 먹었지", meals) > 0, true);
  eq(scoreEntry("", meals), 0);
  eq(scoreEntry("임플란트 몇 개야", meals), 0);
  // conjugated Korean still reaches the right collection, weakly
  eq(scoreEntry("오늘 뭐 먹을까", meals) > 0, true);
  eq(scoreEntry("오늘 뭐 먹을까", workout), 0);

  const ranked = rankEntries("오늘 밥 뭐 먹었지", [workout, meals]);
  eq(ranked.length, 1);
  eq(ranked[0].entry.collection_name, "meals");
  eq(rankEntries("운동", [workout, meals], 3)[0].entry.collection_name, "workout");
  eq(rankEntries("아무거나", [workout, meals]).length, 0);
  // similar-category detection
  const draft = (over: Partial<CategoryDraft>): CategoryDraft => ({
    collection_name: "food_log",
    description: "먹은 음식과 식사 시간 기록",
    keywords: ["식사", "음식"],
    ...over,
  });
  eq(findSimilarCategories(draft({}), [meals, workout])[0].collection.collection_name, "meals");
  eq(findSimilarCategories(draft({ collection_name: "meal" }), [meals])[0].similarity >= 0.3, true);
  eq(
    findSimilarCategories(
      draft({ collection_name: "implant", description: "임플란트 시술 개수와 위치", keywords: ["임플란트", "치아"] }),
      [meals, workout],
    ).length,
    0,
  );
  console.log("score.ts self-check OK");
}
