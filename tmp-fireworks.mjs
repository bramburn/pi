import { readFileSync, writeFileSync } from "node:fs";

const values = JSON.parse(readFileSync("packages/ai/src/providers/data/fireworks.json", "utf8"));
const want = process.argv[2] ?? "kimi";
const out = [];
for (const [api, models] of Object.entries(values)) {
	for (const [id, m] of Object.entries(models)) {
		if (!id.includes(want)) continue;
		out.push(`### [${api}] ${id}`);
		out.push(JSON.stringify(m, null, 2));
		out.push("");
	}
}
writeFileSync("tmp-fireworks-out.txt", out.join("\n"), "utf8");
console.log(`wrote ${out.length} lines`);