import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "packages/ai/src/providers/data";
const stale = new Map([
	["moonshotai/Kimi-K2.6", []],
	["kimi-k2.6", []],
	["accounts/fireworks/models/kimi-k2p6", []],
	["accounts/fireworks/models/glm-5p2", []],
	["accounts/fireworks/routers/glm-5p2-fast", []],
	["deepseek-ai/DeepSeek-V4-Pro", []],
]);

for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
	let values;
	try {
		values = JSON.parse(readFileSync(join(dir, f), "utf8"));
	} catch {
		continue;
	}
	const apiIds = new Map();
	for (const [api, models] of Object.entries(values)) {
		apiIds.set(api, Object.keys(models));
	}
	const flat = [...apiIds.values()].flat();
	for (const [id, hits] of stale) {
		if (flat.includes(id)) hits.push(f);
	}
	console.log(`\n== ${f}`);
	for (const [api, ids] of apiIds) {
		console.log(`   [${api}] ${ids.join(", ")}`);
	}
}

console.log("\n\n===== STALE ID -> provider files containing it =====");
for (const [id, hits] of stale) {
	console.log(`${id}: ${hits.length ? hits.join(", ") : "NOT PRESENT ANYWHERE"}`);
}