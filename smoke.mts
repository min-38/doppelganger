import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], cwd: process.cwd(),
  env: { ...process.env as Record<string,string>, TURSO_DATABASE_URL: "file:" + process.env.SP + "/cat.db" } }));
const call = async (n: string, a: any) => (await client.callTool({ name: n, arguments: a }) as any);
const t = (r: any) => r.content[0].text;

console.log("create:", t(await call("create_category", { collection_name: "meals",
  description: "식사 시간과 먹은 음식, 칼로리 기록. '오늘 뭐 먹을까', '다이어트 잘 되나' 같은 질문에 답하기 위한 데이터",
  category_group: "food", keywords: ["식사","밥","음식","칼로리"], sample_fields: ["date","food"] })).slice(0,300));
console.log("dup:", t(await call("create_category", { collection_name: "meals", description: "중복 생성 시도 테스트용 설명입니다", category_group: "food", keywords: ["식사"] })).slice(0,120));
console.log("reserved:", t(await call("create_category", { collection_name: "_meta", description: "예약어 테스트용 설명입니다", category_group: "x", keywords: ["a"] })).slice(0,150));
console.log("badname:", JSON.stringify(await call("create_category", { collection_name: "Meals; DROP TABLE _meta", description: "잘못된 이름 테스트용 설명입니다", category_group: "x", keywords: ["a"] })).slice(0,200));
console.log("shortdesc:", JSON.stringify(await call("create_category", { collection_name: "sleep", description: "짧음", category_group: "health", keywords: ["수면"] })).slice(0,180));
console.log("find:", t(await call("find_relevant_collections", { query: "오늘 뭐 먹을까" })).slice(0,120));
