// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the samples end up: for each server, the time spans when it was running ("up") and online, merged as
 * they come. Times are unix seconds. Spans older than two years are dropped; uptime is computed over the last
 * year (or since the server's first sample, when that's more recent).
 */
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const MINUTE = 60;
export const DAY = 86_400;
/** What's kept: a rolling two years. */
export const KEEP = 2 * 365 * DAY;
/** What uptime is computed over: a rolling year. */
export const WINDOW = 365 * DAY;
/** How far apart two online minutes can be and still join up: the timer's jitter. */
const SLACK = 5;

export type Kind = 'up' | 'online';
export type Span = [start: number, end: number];
/** One line from an agent: when, the machine's boot time, and whether a host answered its ping. */
export type Sample = { at: number; boot: number; online: boolean };
export type ServerRow = { id: number; name: string; created_at: number; first_at: number | null; last_at: number | null; last_online: number | null };

/** Sorts and merges spans that overlap, or nearly touch (within `slack`). */
export function merge(spans: Span[], slack = 0): Span[] {
	const out: Span[] = [];
	for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = out.at(-1);
		if (last && start <= last[1] + slack) last[1] = Math.max(last[1], end);
		else out.push([start, end]);
	}
	return out;
}

/** A sample proves the machine ran from its boot until then, and, when online, during the minute before. */
export function spansOf(samples: Sample[]): Record<Kind, Span[]> {
	return {
		up: merge(samples.map(s => [s.boot, s.at])),
		online: merge(samples.filter(s => s.online).map(s => [Math.max(s.at - MINUTE, s.boot), s.at]), SLACK),
	};
}

/** Parses an agent's report: one sample per line; lines that aren't one, or are out of range, are skipped. */
export function parseReport(text: string, now: number) {
	const samples: Sample[] = [];
	let skipped = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const m = /^(\d{1,12}) (\d{1,12}) ([01])$/.exec(line.trim());
		const at = Number(m?.[1]);
		const boot = Number(m?.[2]);
		if (!m || at > now + 5 * MINUTE || at < now - KEEP || boot > at || boot <= 0) skipped++;
		else samples.push({ at, boot, online: m[3] === '1' });
	}
	return { samples, skipped };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function openStore(path: string) {
	const db = new DatabaseSync(path);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS servers (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			token_hash TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			-- Its first and latest samples, and whether it was online at the latest.
			first_at INTEGER,
			last_at INTEGER,
			last_online INTEGER
		);
		CREATE TABLE IF NOT EXISTS spans (
			server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			kind TEXT NOT NULL CHECK (kind IN ('up', 'online')),
			start_at INTEGER NOT NULL,
			end_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS spans_by_server ON spans(server_id, kind, end_at);
	`);
	const q = {
		near: db.prepare('SELECT rowid, start_at, end_at FROM spans WHERE server_id = ? AND kind = ? AND end_at >= ? AND start_at <= ?'),
		drop: db.prepare('DELETE FROM spans WHERE rowid = ?'),
		insert: db.prepare('INSERT INTO spans (server_id, kind, start_at, end_at) VALUES (?, ?, ?, ?)'),
		within: db.prepare('SELECT start_at, end_at FROM spans WHERE server_id = ? AND kind = ? AND end_at > ? AND start_at < ? ORDER BY start_at'),
		seen: db.prepare(`UPDATE servers SET first_at = MIN(COALESCE(first_at, ?), ?),
			last_online = CASE WHEN last_at IS NULL OR ? >= last_at THEN ? ELSE last_online END, last_at = MAX(COALESCE(last_at, ?), ?) WHERE id = ?`),
	};

	/** Adds a span to what's stored, merged with the spans it overlaps or nearly touches. */
	function add(serverId: number, kind: Kind, [start, end]: Span) {
		const slack = kind === 'online' ? SLACK : 0;
		const near = q.near.all(serverId, kind, start - slack, end + slack) as { rowid: number; start_at: number; end_at: number }[];
		for (const r of near) q.drop.run(r.rowid);
		q.insert.run(serverId, kind, Math.min(start, ...near.map(r => r.start_at)), Math.max(end, ...near.map(r => r.end_at)));
	}

	/** The server's `kind` spans clipped to [from, to]. */
	const within = (serverId: number, kind: Kind, from: number, to: number) =>
		(q.within.all(serverId, kind, from, to) as { start_at: number; end_at: number }[]).map(r => [Math.max(r.start_at, from), Math.min(r.end_at, to)] as Span);
	const total = (spans: Span[]) => spans.reduce((sum, [start, end]) => sum + end - start, 0);

	return {
		db,

		addServer(name: string, now = Math.floor(Date.now() / 1000)) {
			const token = `upt_${randomBytes(32).toString('base64url')}`;
			db.prepare('INSERT INTO servers (name, token_hash, created_at) VALUES (?, ?, ?)').run(name, hashToken(token), now);
			return token;
		},
		newToken(name: string) {
			const token = `upt_${randomBytes(32).toString('base64url')}`;
			return db.prepare('UPDATE servers SET token_hash = ? WHERE name = ?').run(hashToken(token), name).changes ? token : null;
		},
		rename: (name: string, to: string) => db.prepare('UPDATE servers SET name = ? WHERE name = ?').run(to, name).changes > 0,
		remove: (name: string) => db.prepare('DELETE FROM servers WHERE name = ?').run(name).changes > 0,
		servers: () => db.prepare('SELECT id, name, created_at, first_at, last_at, last_online FROM servers ORDER BY name').all() as ServerRow[],
		serverByToken: (token: string) => db.prepare('SELECT id, name FROM servers WHERE token_hash = ?').get(hashToken(token)) as { id: number; name: string } | undefined,

		/** Stores an agent's samples. Sending the same ones twice changes nothing. */
		record(serverId: number, samples: Sample[]) {
			if (!samples.length) return;
			const spans = spansOf(samples);
			const latest = samples.reduce((a, b) => (b.at > a.at ? b : a));
			const first = Math.min(...samples.map(s => s.at));
			db.exec('BEGIN');
			try {
				for (const kind of ['up', 'online'] as const) for (const span of spans[kind]) add(serverId, kind, span);
				q.seen.run(first, first, latest.at, latest.online ? 1 : 0, latest.at, latest.at, serverId);
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},

		/** Forgets what's older than two years. */
		prune(now = Math.floor(Date.now() / 1000)) {
			db.prepare('DELETE FROM spans WHERE end_at <= ?').run(now - KEEP);
			db.prepare('UPDATE spans SET start_at = ? WHERE start_at < ?').run(now - KEEP, now - KEEP);
		},

		/**
		 * A server's uptime over the last year and the last 30 days (from its first sample, if later), and day by
		 * day (UTC). Seconds: `tracked` is the time looked at, `up` the time it ran, `online` the time it was online.
		 * Up to its latest sample while that's recent; once it's missed two ticks, up to now: time without news counts
		 * as neither running nor online, unless its samples arrive later.
		 */
		uptime(server: ServerRow, now = Math.floor(Date.now() / 1000)) {
			if (server.first_at === null || server.last_at === null) return null;
			const to = now - server.last_at <= 2 * MINUTE ? Math.min(server.last_at, now) : now;
			const from = Math.max(now - WINDOW, server.first_at - MINUTE);
			const spans = { up: within(server.id, 'up', from, to), online: within(server.id, 'online', from, to) };
			const over = (start: number, end = to) => {
				const clip = (list: Span[]) => total(list.filter(([s, e]) => e > start && s < end).map(([s, e]) => [Math.max(s, start), Math.min(e, end)] as Span));
				return { tracked: Math.max(0, end - start), up: clip(spans.up), online: clip(spans.online) };
			};
			const days = [];
			for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) days.push({ day, ...over(Math.max(day, from), Math.min(day + DAY, to)) });
			return { from, year: over(from), month: over(Math.max(now - 30 * DAY, from)), days };
		},
	};
}

export type Store = ReturnType<typeof openStore>;
