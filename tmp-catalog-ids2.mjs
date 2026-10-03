import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "packages/ai/src/providers/data";

for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
	if (f === ".manifest.json") continue;
	const values = JSON.parse(readFileSync(join(dir, f), "utf8"));
	const groups = Object.entries(values).map(([api, models]) => [api, Object.keys(models)]);
	const flat = groups.flatMap(([, ids]) => ids);
	const interesting = ["fireworks.json"].includes(f) || flat.includes("minimax-m3") || flat.includes("qwen3.8-flash");
	if (!interesting) continue;
	console.log(`\n== ${f}`);
	for (const [api, ids] of groups) console.log(`   [${api}] (${ids.length}) ${ids.join(", ")}`);
}