import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface FactRow {
	session_id: string;
	seq: number;
	kind: string;
	key: string | null;
	value: string | null;
}

export function appendFact(
	db: SqliteDatabase,
	sessionId: string,
	seq: number,
	kind: string,
	key: string | null,
	value: string | null,
) {
	sql`INSERT INTO facts (session_id, seq, kind, key, value) VALUES (${sessionId}, ${seq}, ${kind}, ${key}, ${value})`.run(
		db,
	);
}

export function readLatestFact(db: SqliteDatabase, sessionId: string, kind: string, key: string | null) {
	return sql`SELECT session_id, seq, kind, key, value
		FROM facts INDEXED BY idx_facts_session_kind_key_seq
		WHERE session_id = ${sessionId} AND kind = ${kind} AND key IS ${key}
		ORDER BY seq DESC
		LIMIT 1`.get<FactRow>(db);
}

export function readLatestLabelFacts(db: SqliteDatabase, sessionId: string) {
	// Window function eliminates the per-key correlated subquery (N+1 → 1 query).
	// The `value IS NOT NULL` filter is applied to the row the window function picked
	// (rn=1) — i.e. the actual latest fact per key. If that latest fact is null, the key
	// has been "deleted" and is excluded. Filtering in the inner subquery would let a
	// stale non-null row leak through as the "latest" for a deleted key.
	return sql`SELECT key, value FROM (
			SELECT key, value,
				ROW_NUMBER() OVER (
					PARTITION BY key
					ORDER BY seq DESC
				) AS rn
			FROM facts
			WHERE session_id = ${sessionId}
				AND kind = 'label'
		) sub
		WHERE rn = 1 AND value IS NOT NULL
		ORDER BY key`.all<{ key: string; value: string }>(db);
}

export function readFactRows(
	db: SqliteDatabase,
	sessionId: string,
	options: { afterSeq?: number; limit?: number } = {},
) {
	const after = options.afterSeq === undefined ? sql`` : sql` AND seq > ${options.afterSeq}`;
	const limit = options.limit === undefined ? sql`` : sql` LIMIT ${options.limit}`;
	return sql`SELECT session_id, seq, kind, key, value
		FROM facts
		WHERE session_id = ${sessionId}${after}
		ORDER BY seq${limit}`.all<FactRow>(db);
}

export function deleteFactRows(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM facts WHERE session_id = ${sessionId}`.run(db);
}
