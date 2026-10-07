/**
 * Analytics SQLite store for pi run instrumentation.
 *
 * Logs are written to `~/.pi/analytics/YYYY-MM.db` (monthly rotation).
 * All writes are immediate (no batching); flushed on `agent_settled`.
 *
 * Schema:
 *   pi_runs            – one row per run, keyed by runId
 *   pi_tool_invocations – one row per tool call within a run
 *   pi_compaction_events – one row per compaction within a run
 *   pi_subagent_tasks    – one row per sub-agent task span
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getAnalyticsDir } from "../config.ts";

/** Test-only override: when set, analytics is written under this home. */
function resolveAnalyticsDir(): string {
	const testHome = process.env.PI_TEST_ANALYTICS_HOME;
	if (testHome) return join(testHome, "analytics");
	return getAnalyticsDir();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunRow {
	runId: string;
	sessionId: string;
	trackingId: string | null;
	outcome: "completed" | "aborted" | "failed";
	abortedBy: "user" | "timeout" | "error" | null;
	errorCode: string | null;
	startTime: number; // Unix ms
	endTime: number; // Unix ms
	turnCount: number;
	toolInvocations: number;
	toolErrors: number;
	compactionTriggered: boolean;
	usageInputTokens: number;
	usageOutputTokens: number;
	usageCost: number;
	ttftMs: number | null;
}

export interface ToolInvocationRow {
	id: string;
	runId: string;
	toolName: string;
	isError: boolean;
	startTime: number; // Unix ms
	durationMs: number;
	inputTokens: number | null;
	outputTokens: number | null;
}

export interface CompactionEventRow {
	id: string;
	runId: string;
	reason: "manual" | "threshold" | "overflow";
	startTime: number; // Unix ms
	durationMs: number;
	success: boolean;
	willRetry: boolean;
}

export interface SubagentTaskRow {
	id: string;
	runId: string;
	spanId: string;
	parentSpanId: string | null;
	agentName: string;
	taskLabel: string;
	startTime: number; // Unix ms
	endTime: number | null;
	success: boolean | null;
	errorMessage: string | null;
	durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class AnalyticsStore {
	private db: Database.Database | null = null;

	/** Path to the current month's DB (lazily computed) */
	private getPath(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		return `${resolveAnalyticsDir()}/${year}-${month}.db`;
	}

	private ensureDir(): void {
		const dir = dirname(this.getPath());
		mkdirSync(dir, { recursive: true });
	}

	private open(): void {
		if (this.db) return;
		const dbPath = this.getPath();
		this.ensureDir();
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.createTables();
	}

	private createTables(): void {
		this.db!.exec(`
			CREATE TABLE IF NOT EXISTS pi_runs (
				run_id          TEXT PRIMARY KEY,
				session_id      TEXT NOT NULL,
				tracking_id     TEXT,
				outcome         TEXT NOT NULL,
				aborted_by      TEXT,
				error_code      TEXT,
				start_time      INTEGER NOT NULL,
				end_time        INTEGER NOT NULL,
				turn_count      INTEGER NOT NULL DEFAULT 0,
				tool_invocations INTEGER NOT NULL DEFAULT 0,
				tool_errors     INTEGER NOT NULL DEFAULT 0,
				compaction_triggered INTEGER NOT NULL DEFAULT 0,
				usage_input_tokens  INTEGER NOT NULL DEFAULT 0,
				usage_output_tokens INTEGER NOT NULL DEFAULT 0,
				usage_cost      REAL NOT NULL DEFAULT 0,
				ttft_ms         REAL
			);

			CREATE TABLE IF NOT EXISTS pi_tool_invocations (
				id              TEXT PRIMARY KEY,
				run_id          TEXT NOT NULL,
				tool_name       TEXT NOT NULL,
				is_error        INTEGER NOT NULL DEFAULT 0,
				start_time      INTEGER NOT NULL,
				duration_ms     INTEGER NOT NULL DEFAULT 0,
				input_tokens    INTEGER,
				output_tokens   INTEGER,
				FOREIGN KEY (run_id) REFERENCES pi_runs(run_id)
			);

			CREATE TABLE IF NOT EXISTS pi_compaction_events (
				id              TEXT PRIMARY KEY,
				run_id          TEXT NOT NULL,
				reason          TEXT NOT NULL,
				start_time      INTEGER NOT NULL,
				duration_ms     INTEGER NOT NULL DEFAULT 0,
				success         INTEGER NOT NULL DEFAULT 0,
				will_retry      INTEGER NOT NULL DEFAULT 0,
				FOREIGN KEY (run_id) REFERENCES pi_runs(run_id)
			);

			CREATE TABLE IF NOT EXISTS pi_subagent_tasks (
				id              TEXT PRIMARY KEY,
				run_id          TEXT NOT NULL,
				span_id         TEXT NOT NULL,
				parent_span_id  TEXT,
				agent_name      TEXT NOT NULL,
				task_label      TEXT NOT NULL,
				start_time       INTEGER NOT NULL,
				end_time        INTEGER,
				success         INTEGER,
				error_message   TEXT,
				duration_ms     INTEGER,
				FOREIGN KEY (run_id) REFERENCES pi_runs(run_id)
			);

			CREATE INDEX IF NOT EXISTS idx_runs_session ON pi_runs(session_id);
			CREATE INDEX IF NOT EXISTS idx_runs_tracking ON pi_runs(tracking_id);
			CREATE INDEX IF NOT EXISTS idx_tools_run ON pi_tool_invocations(run_id);
			CREATE INDEX IF NOT EXISTS idx_compaction_run ON pi_compaction_events(run_id);
			CREATE INDEX IF NOT EXISTS idx_subagent_run ON pi_subagent_tasks(run_id);
		`);
	}

	// -------------------------------------------------------------------------
	// Run lifecycle
	// -------------------------------------------------------------------------

	private _currentRunId: string | null = null;
	private _currentSessionId: string | null = null;
	private _currentTrackingId: string | null = null;
	private _runStartTime: number = 0;
	private _turnCount: number = 0;
	private _compactionTriggered: boolean = false;
	private _usageInputTokens: number = 0;
	private _usageOutputTokens: number = 0;
	private _usageCost: number = 0;
	private _ttftMs: number | null = null;
	private _pendingToolInvocations: ToolInvocationRow[] = [];
	private _pendingCompactionEvents: CompactionEventRow[] = [];

	beginRun(sessionId: string, trackingId: string | null): string {
		this.open();
		this._currentRunId = randomUUID();
		this._currentSessionId = sessionId;
		this._currentTrackingId = trackingId;
		this._runStartTime = Date.now();
		this._turnCount = 0;
		this._compactionTriggered = false;
		this._usageInputTokens = 0;
		this._usageOutputTokens = 0;
		this._usageCost = 0;
		this._ttftMs = null;
		this._pendingToolInvocations = [];
		this._pendingCompactionEvents = [];
		this._pendingSubagentTasks = new Map();
		return this._currentRunId;
	}

	recordTurn(): void {
		this._turnCount++;
	}

	recordCompaction(
		reason: "manual" | "threshold" | "overflow",
		durationMs: number,
		success: boolean,
		willRetry: boolean,
	): void {
		this._compactionTriggered = true;
		const row: CompactionEventRow = {
			id: randomUUID(),
			runId: this._currentRunId!,
			reason,
			startTime: Date.now() - durationMs,
			durationMs,
			success,
			willRetry,
		};
		this._pendingCompactionEvents.push(row);
	}

	recordUsage(inputTokens: number, outputTokens: number, cost: number): void {
		this._usageInputTokens += inputTokens;
		this._usageOutputTokens += outputTokens;
		this._usageCost += cost;
	}

	recordTTFT(ms: number): void {
		this._ttftMs ??= ms;
	}

	recordToolInvocation(
		toolName: string,
		isError: boolean,
		durationMs: number,
		inputTokens?: number,
		outputTokens?: number,
	): void {
		const row: ToolInvocationRow = {
			id: randomUUID(),
			runId: this._currentRunId!,
			toolName,
			isError,
			startTime: Date.now() - durationMs,
			durationMs,
			inputTokens: inputTokens ?? null,
			outputTokens: outputTokens ?? null,
		};
		this._pendingToolInvocations.push(row);
	}

	flushRun(
		outcome: "completed" | "aborted" | "failed",
		abortedBy?: "user" | "timeout" | "error",
		errorCode?: string,
	): void {
		if (!this._currentRunId) return;
		const endTime = Date.now();

		const toolErrors = this._pendingToolInvocations.filter((t) => t.isError).length;

		const insertRun = this.db!.prepare(`
			INSERT OR REPLACE INTO pi_runs
				(run_id, session_id, tracking_id, outcome, aborted_by, error_code,
				 start_time, end_time, turn_count, tool_invocations, tool_errors,
				 compaction_triggered, usage_input_tokens, usage_output_tokens, usage_cost, ttft_ms)
			VALUES
				(@runId, @sessionId, @trackingId, @outcome, @abortedBy, @errorCode,
				 @startTime, @endTime, @turnCount, @toolInvocations, @toolErrors,
				 @compactionTriggered, @usageInputTokens, @usageOutputTokens, @usageCost, @ttftMs)
		`);

		insertRun.run({
			runId: this._currentRunId,
			sessionId: this._currentSessionId,
			trackingId: this._currentTrackingId,
			outcome,
			abortedBy: abortedBy ?? null,
			errorCode: errorCode ?? null,
			startTime: this._runStartTime,
			endTime,
			turnCount: this._turnCount,
			toolInvocations: this._pendingToolInvocations.length,
			toolErrors,
			compactionTriggered: this._compactionTriggered ? 1 : 0,
			usageInputTokens: this._usageInputTokens,
			usageOutputTokens: this._usageOutputTokens,
			usageCost: this._usageCost,
			ttftMs: this._ttftMs,
		});

		const insertTool = this.db!.prepare(`
			INSERT INTO pi_tool_invocations
				(id, run_id, tool_name, is_error, start_time, duration_ms, input_tokens, output_tokens)
			VALUES
				(@id, @runId, @toolName, @isError, @startTime, @durationMs, @inputTokens, @outputTokens)
		`);
		const toolInsertMany = this.db!.transaction((rows: ToolInvocationRow[]) => {
			for (const row of rows) {
				insertTool.run({
					id: row.id,
					runId: row.runId,
					toolName: row.toolName,
					isError: row.isError ? 1 : 0,
					startTime: row.startTime,
					durationMs: row.durationMs,
					inputTokens: row.inputTokens,
					outputTokens: row.outputTokens,
				});
			}
		});
		toolInsertMany(this._pendingToolInvocations);

		const insertComp = this.db!.prepare(`
			INSERT INTO pi_compaction_events
				(id, run_id, reason, start_time, duration_ms, success, will_retry)
			VALUES
				(@id, @runId, @reason, @startTime, @durationMs, @success, @willRetry)
		`);
		const compInsertMany = this.db!.transaction((rows: CompactionEventRow[]) => {
			for (const row of rows) {
				insertComp.run({
					id: row.id,
					runId: row.runId,
					reason: row.reason,
					startTime: row.startTime,
					durationMs: row.durationMs,
					success: row.success ? 1 : 0,
					willRetry: row.willRetry ? 1 : 0,
				});
			}
		});
		compInsertMany(this._pendingCompactionEvents);

		// Sub-agent spans are inserted only here: pi_subagent_tasks.run_id
		// references pi_runs(run_id), whose row is inserted above, so an INSERT
		// from endSubagentTask during the run always violated the foreign key.
		// Spans that settle after this flush are closed in place by
		// endSubagentTask's UPDATE path below.
		const insertSubagent = this.db!.prepare(`
			INSERT INTO pi_subagent_tasks
				(id, run_id, span_id, parent_span_id, agent_name, task_label,
				 start_time, end_time, success, error_message, duration_ms)
			VALUES
				(@id, @runId, @spanId, @parentSpanId, @agentName, @taskLabel,
				 @startTime, @endTime, @success, @errorMessage, @durationMs)
		`);
		const subagentInsertMany = this.db!.transaction((rows: SubagentTaskRow[]) => {
			for (const row of rows) {
				insertSubagent.run({
					id: row.id,
					runId: row.runId,
					spanId: row.spanId,
					parentSpanId: row.parentSpanId,
					agentName: row.agentName,
					taskLabel: row.taskLabel,
					startTime: row.startTime,
					endTime: row.endTime,
					success: row.success === null ? null : row.success ? 1 : 0,
					errorMessage: row.errorMessage,
					durationMs: row.durationMs,
				});
			}
		});
		subagentInsertMany([...this._pendingSubagentTasks.values()]);

		this._currentRunId = null;
		this._currentSessionId = null;
		this._currentTrackingId = null;
		this._pendingToolInvocations = [];
		this._pendingCompactionEvents = [];
		this._pendingSubagentTasks = new Map();
	}

	// -------------------------------------------------------------------------
	// Sub-agent task spans
	// -------------------------------------------------------------------------

	private _pendingSubagentTasks = new Map<string, SubagentTaskRow>();

	startSubagentTask(params: { spanId: string; parentSpanId?: string; agentName: string; taskLabel: string }): void {
		if (!this._currentRunId) return;
		const row: SubagentTaskRow = {
			id: randomUUID(),
			runId: this._currentRunId,
			spanId: params.spanId,
			parentSpanId: params.parentSpanId ?? null,
			agentName: params.agentName,
			taskLabel: params.taskLabel,
			startTime: Date.now(),
			endTime: null,
			success: null,
			errorMessage: null,
			durationMs: null,
		};
		this._pendingSubagentTasks.set(params.spanId, row);
	}

	endSubagentTask(spanId: string, success: boolean, errorMessage?: string): void {
		const endTime = Date.now();
		const row = this._pendingSubagentTasks.get(spanId);
		if (row) {
			// First settle wins: a double settle must not rewrite the outcome or
			// extend the duration.
			if (row.endTime !== null) return;
			// Fast path: no DB write here — the row is inserted by flushRun together
			// with its pi_runs parent (see the foreign-key note there).
			this._pendingSubagentTasks.set(spanId, {
				...row,
				endTime,
				success: !!success,
				errorMessage: errorMessage ?? null,
				durationMs: endTime - row.startTime,
			});
			return;
		}
		// The span was already flushed (e.g. a background task settling after
		// flushRun): close its row in place so the outcome is not lost.
		if (!this.db) return;
		// First settle wins here too: `AND end_time IS NULL` makes a late double
		// settle a no-op instead of inflating the duration with a new timestamp.
		const update = this.db.prepare(`
			UPDATE pi_subagent_tasks
			SET end_time = @endTime,
				success = @success,
				error_message = @errorMessage,
				duration_ms = @endTime - start_time
			WHERE span_id = @spanId AND end_time IS NULL
		`);
		update.run({
			spanId,
			endTime,
			success: success ? 1 : 0,
			errorMessage: errorMessage ?? null,
		});
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _store: AnalyticsStore | null = null;

export function getAnalyticsStore(): AnalyticsStore {
	if (!_store) _store = new AnalyticsStore();
	return _store;
}

/**
 * Generate a new task span ID for sub-agent instrumentation.
 * Call startSubagentTask when the subprocess spawns, endSubagentTask when it exits.
 */
export function newTaskSpanId(): string {
	return randomUUID();
}

/**
 * Start a sub-agent task span.
 * Idempotent — safe to call multiple times with the same spanId.
 * Best-effort telemetry — never throws, so analytics I/O cannot fail a run.
 */
export function startSubagentTask(params: {
	spanId: string;
	parentSpanId?: string;
	agentName: string;
	taskLabel: string;
}): void {
	try {
		getAnalyticsStore().startSubagentTask(params);
	} catch {
		// telemetry only — ignore
	}
}

/**
 * End a sub-agent task span.
 * Idempotent — safe to call multiple times with the same spanId.
 * Best-effort telemetry — never throws, so analytics I/O cannot fail a run.
 */
export function endSubagentTask(spanId: string, success: boolean, errorMessage?: string): void {
	try {
		getAnalyticsStore().endSubagentTask(spanId, success, errorMessage);
	} catch {
		// telemetry only — ignore
	}
}
