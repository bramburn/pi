#!/usr/bin/env node
/**
 * A/B-test candidate models as the context-compaction summariser.
 *
 * Feeds a recorded session JSONL through the repo's real compaction summary
 * generator (generateSummaryWithUsage from packages/coding-agent) once per
 * candidate model config and prints a comparison table.
 *
 * Usage:
 *   node scripts/experiment-summariser.mjs [--fixture <path>] [--configs <file.json>]
 *   node scripts/experiment-summariser.mjs --self-test
 *   node scripts/experiment-summariser.mjs --help
 *
 * Config file: JSON array of
 *   { "name": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1",
 *     "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY",
 *     "maxTokens": 16384, "thinking": "off" }
 * `maxTokens` and `thinking` are optional.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = path.join(REPO_ROOT, "packages/coding-agent/test/fixtures/large-session.jsonl");
const COMPACTION_MODULE = path.join(REPO_ROOT, "packages/coding-agent/src/core/compaction/compaction.ts");
const RESERVE_TOKENS = 16384;
const PROVIDER_ID = "summariser-experiment";

const USAGE = `Usage: node scripts/experiment-summariser.mjs [options]

Options:
  --fixture <path>     Session JSONL fixture (default: packages/coding-agent/test/fixtures/large-session.jsonl)
  --configs <file>     JSON array of model configs (see script header)
  --self-test          Offline mode: mock OpenAI endpoint + two fake configs
  --help               Show this text
`;

function parseArgs(argv) {
	const args = { fixture: DEFAULT_FIXTURE, configs: undefined, selfTest: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--fixture":
				args.fixture = path.resolve(REPO_ROOT, argv[++i]);
				break;
			case "--configs":
				args.configs = path.resolve(REPO_ROOT, argv[++i]);
				break;
			case "--self-test":
				args.selfTest = true;
				break;
			case "--help":
			case "-h":
				args.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

async function loadGenerateSummary() {
	try {
		const mod = await import(pathToFileURL(COMPACTION_MODULE).href);
		return mod.generateSummaryWithUsage;
	} catch (err) {
		console.error(
			`Failed to import ${path.relative(REPO_ROOT, COMPACTION_MODULE)}: ${err.message}\n` +
				"Run this script from the repo root on Node >= 22.18 (TypeScript type stripping is required, " +
				"and workspace deps resolve via the hoisted root node_modules).",
		);
		process.exit(1);
	}
}

async function readFixtureMessages(fixturePath) {
	const raw = await readFile(fixturePath, "utf8");
	const messages = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		if (entry.type !== "message") continue;
		messages.push(entry.message !== undefined ? entry.message : entry);
	}
	if (messages.length === 0) throw new Error(`No message entries found in ${fixturePath}`);
	return messages;
}

function buildModel(cfg) {
	const thinking = cfg.thinking ?? "off";
	return {
		id: cfg.model,
		name: cfg.name ?? cfg.model,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: cfg.baseUrl,
		reasoning: thinking !== "off",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: cfg.maxTokens ?? 16384,
	};
}

async function runConfig(generateSummaryWithUsage, cfg, messages) {
	const started = performance.now();
	const row = { name: cfg.name ?? cfg.model, model: cfg.model, status: "ok", output: 0, reasoning: 0, chars: 0, words: 0, elapsedMs: 0, error: undefined, text: undefined };
	const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
	if (!apiKey) {
		row.status = "err";
		row.error = `env var ${cfg.apiKeyEnv} is not set`;
		return row;
	}
	try {
		const { text, usage } = await generateSummaryWithUsage(messages, buildModel(cfg), RESERVE_TOKENS, apiKey);
		row.elapsedMs = Math.round(performance.now() - started);
		row.output = usage?.output ?? 0;
		row.reasoning = usage?.reasoning ?? 0;
		row.chars = text.length;
		row.words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
		row.text = text;
	} catch (err) {
		row.elapsedMs = Math.round(performance.now() - started);
		row.status = "err";
		row.error = err instanceof Error ? err.message : String(err);
	}
	return row;
}

function printTable(rows) {
	const esc = (v) => String(v).replace(/\|/g, "\\|");
	const lines = [
		"| name | model | status | output tok | reasoning tok | summary chars | summary words | elapsed ms |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const r of rows) {
		lines.push(
			`| ${esc(r.name)} | ${esc(r.model)} | ${r.status}${r.error ? `: ${esc(r.error.split("\n")[0].slice(0, 80))}` : ""} | ${r.output} | ${r.reasoning} | ${r.chars} | ${r.words} | ${r.elapsedMs} |`,
		);
	}
	console.log(lines.join("\n"));
	const first = rows.find((r) => r.text !== undefined);
	if (first) {
		console.log(`\n<details>\n<summary>Full summary — ${esc(first.name)}</summary>\n\n${first.text}\n\n</details>`);
	}
}

async function readConfigs(configsPath) {
	const parsed = JSON.parse(await readFile(configsPath, "utf8"));
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${configsPath} must contain a non-empty JSON array`);
	return parsed;
}

// ---------------------------------------------------------------------------
// Self-test: mock OpenAI chat-completions endpoint speaking the exact SSE
// dialect packages/ai/src/api/openai-completions.ts parses: delta content
// chunks, a finish_reason chunk, a final chunk with top-level `usage`
// (the client requests stream_options.include_usage), then `data: [DONE]`.
// ---------------------------------------------------------------------------

function startMockServer() {
	const base = { id: "chatcmpl-selftest", object: "chat.completion.chunk", created: 0, model: "self-test-model" };
	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
			const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
			chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "## Goal\nFake mock " }, finish_reason: null }] });
			chunk({ ...base, choices: [{ index: 0, delta: { content: "summary for self-test." }, finish_reason: null }] });
			chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			chunk({
				...base,
				choices: [],
				usage: {
					prompt_tokens: 1000,
					completion_tokens: 42,
					total_tokens: 1042,
					completion_tokens_details: { reasoning_tokens: 7 },
				},
			});
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

async function selfTest(generateSummaryWithUsage, messages) {
	const server = await startMockServer();
	const port = server.address().port;
	process.env.SELFTEST_API_KEY = "self-test";
	const configs = [
		{ name: "mock-a", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock-model-a", apiKeyEnv: "SELFTEST_API_KEY" },
		{ name: "mock-b", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock-model-b", apiKeyEnv: "SELFTEST_API_KEY", thinking: "high" },
	];
	try {
		const rows = [];
		for (const cfg of configs) rows.push(await runConfig(generateSummaryWithUsage, cfg, messages));
		printTable(rows);
		const failures = [];
		if (rows.length !== 2) failures.push(`expected 2 rows, got ${rows.length}`);
		for (const row of rows) {
			if (row.status !== "ok") failures.push(`${row.name}: ${row.error}`);
			if (row.output <= 0) failures.push(`${row.name}: output tokens ${row.output} <= 0`);
			if (row.elapsedMs <= 0) failures.push(`${row.name}: elapsed ${row.elapsedMs} <= 0`);
		}
		if (failures.length > 0) {
			console.error(`\nSELF-TEST FAILED:\n- ${failures.join("\n- ")}`);
			process.exit(1);
		}
		console.log("\nSELF-TEST PASSED");
	} finally {
		server.close();
	}
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err.message);
		console.error(USAGE);
		process.exit(1);
	}
	if (args.help) {
		console.log(USAGE);
		return;
	}
	const generateSummaryWithUsage = await loadGenerateSummary();
	const messages = await readFixtureMessages(args.fixture);
	console.error(`Loaded ${messages.length} messages from ${path.relative(REPO_ROOT, args.fixture)}`);
	if (args.selfTest) {
		await selfTest(generateSummaryWithUsage, messages);
		return;
	}
	if (!args.configs) {
		console.error("--configs is required (or use --self-test)");
		console.error(USAGE);
		process.exit(1);
	}
	const configs = await readConfigs(args.configs);
	const rows = [];
	for (const cfg of configs) {
		console.error(`Running ${cfg.name ?? cfg.model}...`);
		rows.push(await runConfig(generateSummaryWithUsage, cfg, messages));
	}
	printTable(rows);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
