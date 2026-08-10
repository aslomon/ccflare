import type { Database } from "bun:sqlite";
import { Logger } from "@ccflare/logger";
import { extractRequestLinkageFromPayload } from "@ccflare/types";

const BATCH_SIZE = 8;
const MIGRATION_KEY = "request-linkage-v1";
const log = new Logger("RequestLinkageMigration");

type LinkageRow = {
	id: string;
	timestamp: number;
	response_id: string | null;
	previous_response_id: string | null;
	response_chain_id: string | null;
	client_session_id: string | null;
	json: string | null;
};

type ResolvedLinkage = {
	responseId: string | null;
	previousResponseId: string | null;
	responseChainId: string;
	clientSessionId: string | null;
};

function ensureMigrationTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			key TEXT PRIMARY KEY,
			completed_at INTEGER NOT NULL
		)
	`);
}

function isComplete(db: Database): boolean {
	return (
		db
			.query<{ key: string }, [string]>(
				`SELECT key FROM schema_migrations WHERE key = ?`,
			)
			.get(MIGRATION_KEY) !== null
	);
}

function readPayload(json: string | null): unknown {
	if (json === null) return null;
	try {
		const value: unknown = JSON.parse(json);
		return value;
	} catch {
		return null;
	}
}

function resolveLinkage(
	row: LinkageRow,
	responseToChain: Map<string, string>,
): ResolvedLinkage {
	const extracted = extractRequestLinkageFromPayload(readPayload(row.json));
	const previousResponseId =
		extracted.previousResponseId ?? row.previous_response_id;
	const responseId = extracted.responseId ?? row.response_id;
	const responseChainId =
		row.response_chain_id ??
		(previousResponseId
			? (responseToChain.get(previousResponseId) ?? previousResponseId)
			: (responseId ?? row.id));
	if (responseId) responseToChain.set(responseId, responseChainId);

	return {
		responseId,
		previousResponseId,
		responseChainId,
		clientSessionId: extracted.clientSessionId ?? row.client_session_id,
	};
}

function updateRow(
	db: Database,
	row: LinkageRow,
	linkage: ResolvedLinkage,
): number {
	if (
		row.response_id === linkage.responseId &&
		row.previous_response_id === linkage.previousResponseId &&
		row.response_chain_id === linkage.responseChainId &&
		row.client_session_id === linkage.clientSessionId
	) {
		return 0;
	}

	db.run(
		`UPDATE requests SET previous_response_id = ?, response_id = ?,
			response_chain_id = ?, client_session_id = ? WHERE id = ?`,
		[
			linkage.previousResponseId,
			linkage.responseId,
			linkage.responseChainId,
			linkage.clientSessionId,
			row.id,
		],
	);
	return 1;
}

function loadBatch(
	db: Database,
	cursorTimestamp: number,
	cursorId: string,
): LinkageRow[] {
	return db
		.query<LinkageRow, [number, number, string, number]>(
			`SELECT r.id, r.timestamp, r.response_id, r.previous_response_id,
				r.response_chain_id, r.client_session_id, rp.json
			 FROM requests r LEFT JOIN request_payloads rp ON rp.id = r.id
			 WHERE r.timestamp > ? OR (r.timestamp = ? AND r.id > ?)
			 ORDER BY r.timestamp ASC, r.id ASC LIMIT ?`,
		)
		.all(cursorTimestamp, cursorTimestamp, cursorId, BATCH_SIZE);
}

function applyBatch(
	db: Database,
	rows: LinkageRow[],
	responseToChain: Map<string, string>,
): number {
	db.run("BEGIN IMMEDIATE");
	try {
		let updatedRows = 0;
		for (const row of rows) {
			updatedRows += updateRow(db, row, resolveLinkage(row, responseToChain));
		}
		db.run("COMMIT");
		return updatedRows;
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

function backfillInBatches(db: Database): number {
	const responseToChain = new Map<string, string>();
	let cursorTimestamp = -Number.MAX_SAFE_INTEGER;
	let cursorId = "";
	let updatedRows = 0;

	while (true) {
		const rows = loadBatch(db, cursorTimestamp, cursorId);
		if (rows.length === 0) return updatedRows;
		updatedRows += applyBatch(db, rows, responseToChain);
		const lastRow = rows.at(-1);
		if (!lastRow) return updatedRows;
		cursorTimestamp = lastRow.timestamp;
		cursorId = lastRow.id;
	}
}

export function runRequestLinkageMigration(
	db: Database,
	shouldBackfill: boolean,
): void {
	ensureMigrationTable(db);
	if (isComplete(db)) return;

	const updatedRows = shouldBackfill ? backfillInBatches(db) : 0;
	db.run(`INSERT INTO schema_migrations (key, completed_at) VALUES (?, ?)`, [
		MIGRATION_KEY,
		Date.now(),
	]);
	if (updatedRows > 0) {
		log.info(`Backfilled request linkage for ${updatedRows} requests`);
	}
}
