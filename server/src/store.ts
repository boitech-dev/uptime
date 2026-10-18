// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the samples end up: for each server, the time spans when it was running ("up") and online, and for each
 * service, the time spans when its server's checks reached it; all merged as they come. Times are unix seconds.
 * Spans older than two years are dropped; uptime is computed over the last year (or since the first sample, when
 * that's more recent).
 */
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const MINUTE = 60;
export const DAY = 86_400;
/** What's kept: a rolling two years. */
export const KEEP = 2 * 365 * DAY;
/** What uptime is computed over: a rolling year. */
export const WINDOW = 365 * DAY;
/** How far apart two minutes can be and still join up: the timer's jitter. */
const SLACK = 5;

export type Kind = 'up' | 'online';
export type Span = [start: number, end: number];
/** One line from an agent: when, the machine's boot time, and whether a host answered its ping. */
export type Sample = { at: number; boot: number; online: boolean };
/** One service check from an agent: when, which service, whether it answered as expected, and how fast. */
export type Check = { at: number; service: number; ok: boolean; ms: number };
export type ServerRow = { id: number; name: string; created_at: number; first_at: number | null; last_at: number | null; last_online: number | null };
export type ServiceRow = {
	id: number; name: string; server_id: number; server: string; url: string; expect: string | null; group_name: string | null; position: number | null;
	created_at: number; first_at: number | null; last_at: number | null; last_ok: number | null; last_ms: number | null;
};
/** What can change in a service once added (not its server: its history depends on that server). */
export type ServiceEdit = { name?: string; url?: string; expect?: string; group?: string };

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

/** The time two lists of merged, sorted spans have in common. */
export function intersect(a: Span[], b: Span[]): Span[] {
	const out: Span[] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		const start = Math.max(a[i][0], b[j][0]);
		const end = Math.min(a[i][1], b[j][1]);
		if (start < end) out.push([start, end]);
		if (a[i][1] < b[j][1]) i++;
		else j++;
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

/**
 * Parses an agent's report, one line each: samples "<time> <boot time> <0|1>", service checks
 * "<time> svc <service> <0|1> <ms>". Lines that are neither, or out of range, are skipped.
 */
export function parseReport(text: string, now: number) {
	const samples: Sample[] = [];
	const checks: Check[] = [];
	let skipped = 0;
	const inRange = (at: number) => at <= now + 5 * MINUTE && at >= now - KEEP;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const sample = /^(\d{1,12}) (\d{1,12}) ([01])$/.exec(line);
		const check = /^(\d{1,12}) svc (\d{1,9}) ([01]) (\d{1,7})$/.exec(line);
		if (sample && inRange(+sample[1]) && +sample[2] > 0 && +sample[2] <= +sample[1]) samples.push({ at: +sample[1], boot: +sample[2], online: sample[3] === '1' });
		else if (check && inRange(+check[1])) checks.push({ at: +check[1], service: +check[2], ok: check[3] === '1', ms: +check[4] });
		else skipped++;
	}
	return { samples, checks, skipped };
}

/** What's wrong with a service's address or expected text, if anything. */
export function serviceProblem(url: string, expect = '') {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'Give a full address, like https://example.com/health, wss://example.com/live or tcp://127.0.0.1:3306.';
	}
	if (!['http:', 'https:', 'ws:', 'wss:', 'tcp:'].includes(parsed.protocol)) return 'The address must start with http://, https://, ws://, wss:// or tcp://.';
	if (parsed.protocol === 'tcp:' && (!parsed.hostname || !parsed.port)) return 'A tcp:// address needs a host and a port, like tcp://127.0.0.1:3306.';
	if (url.length > 500 || /\s/.test(url)) return 'The address is too long or has spaces in it.';
	if (expect.length > 200 || /[\t\n\r]/.test(expect)) return 'The expected text must be one line, up to 200 characters.';
	return null;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Over [from, to]: the time looked at, and how much of it each list of spans covers; for the year, 30 days, each day. */
function summarize<K extends string>(lists: Record<K, Span[]>, from: number, to: number, now: number) {
	const over = (start: number, end = to) => {
		const totals = {} as Record<K, number>;
		for (const key of Object.keys(lists) as K[]) {
			totals[key] = lists[key].reduce<number>((sum, [s, e]) => sum + Math.max(0, Math.min(e, end) - Math.max(s, start)), 0);
		}
		return { tracked: Math.max(0, end - start), ...totals };
	};
	const days = [];
	for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) days.push({ day, ...over(Math.max(day, from), Math.min(day + DAY, to)) });
	return { from, year: over(from), month: over(Math.max(now - 30 * DAY, from)), days };
}

/** Up to the latest sample while it's recent; once two ticks are missed, up to now: time without news counts as down. */
const until = (lastAt: number, now: number) => (now - lastAt <= 2 * MINUTE ? Math.min(lastAt, now) : now);

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
		-- A service runs on a server, whose agent checks it every minute.
		CREATE TABLE IF NOT EXISTS services (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			url TEXT NOT NULL,
			-- Text the answer must contain (http, tcp).
			expect TEXT,
			-- Where its card goes: under its group's heading, if any, in the order of positions.
			group_name TEXT,
			position INTEGER,
			created_at INTEGER NOT NULL,
			-- Its first and latest checks, and how the latest went.
			first_at INTEGER,
			last_at INTEGER,
			last_ok INTEGER,
			last_ms INTEGER
		);
		-- When its checks reached it.
		CREATE TABLE IF NOT EXISTS service_spans (
			service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
			start_at INTEGER NOT NULL,
			end_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS service_spans_by_service ON service_spans(service_id, end_at);
	`);
	// Databases from before groups and positions.
	if (!(db.prepare('PRAGMA table_info(services)').all() as { name: string }[]).some(c => c.name === 'position')) {
		db.exec('ALTER TABLE services ADD COLUMN group_name TEXT; ALTER TABLE services ADD COLUMN position INTEGER');
	}

	/** Merged spans in `table`, per owner (`keys`): adding one joins it to those it overlaps or nearly touches. */
	function spanTable(table: string, keys: string[]) {
		const where = keys.map(k => `${k} = ?`).join(' AND ');
		const near = db.prepare(`SELECT rowid, start_at, end_at FROM ${table} WHERE ${where} AND end_at >= ? AND start_at <= ?`);
		const drop = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
		const insert = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}, start_at, end_at) VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`);
		const list = db.prepare(`SELECT start_at, end_at FROM ${table} WHERE ${where} AND end_at > ? AND start_at < ? ORDER BY start_at`);
		return {
			add(key: SQLInputValue[], [start, end]: Span, slack = 0) {
				const rows = near.all(...key, start - slack, end + slack) as { rowid: number; start_at: number; end_at: number }[];
				for (const r of rows) drop.run(r.rowid);
				insert.run(...key, Math.min(start, ...rows.map(r => r.start_at)), Math.max(end, ...rows.map(r => r.end_at)));
			},
			/** The owner's spans clipped to [from, to]. */
			within: (key: SQLInputValue[], from: number, to: number) =>
				(list.all(...key, from, to) as { start_at: number; end_at: number }[]).map(r => [Math.max(r.start_at, from), Math.min(r.end_at, to)] as Span),
		};
	}
	const serverSpans = spanTable('spans', ['server_id', 'kind']);
	const serviceSpans = spanTable('service_spans', ['service_id']);
	const q = {
		seen: db.prepare(`UPDATE servers SET first_at = MIN(COALESCE(first_at, ?), ?),
			last_online = CASE WHEN last_at IS NULL OR ? >= last_at THEN ? ELSE last_online END, last_at = MAX(COALESCE(last_at, ?), ?) WHERE id = ?`),
		checked: db.prepare(`UPDATE services SET first_at = MIN(COALESCE(first_at, ?), ?),
			last_ok = CASE WHEN last_at IS NULL OR ? >= last_at THEN ? ELSE last_ok END,
			last_ms = CASE WHEN last_at IS NULL OR ? >= last_at THEN ? ELSE last_ms END, last_at = MAX(COALESCE(last_at, ?), ?) WHERE id = ?`),
	};
	const transaction = (work: () => void) => {
		db.exec('BEGIN');
		try {
			work();
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};

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
		servers: () => db.prepare('SELECT id, name, created_at, first_at, last_at, last_online FROM servers ORDER BY name COLLATE NOCASE').all() as ServerRow[],
		serverByToken: (token: string) => db.prepare('SELECT id, name FROM servers WHERE token_hash = ?').get(hashToken(token)) as { id: number; name: string } | undefined,

		/** Adds a service to the server it runs on (by name); its address must pass `serviceProblem`. */
		/** Adds a service, last, to the server it runs on (by name); its address must pass `serviceProblem`. */
		addService(service: { name: string; server: string; url: string; expect?: string; group?: string }, now = Math.floor(Date.now() / 1000)) {
			const server = db.prepare('SELECT id FROM servers WHERE name = ?').get(service.server) as { id: number } | undefined;
			if (!server) return null;
			return Number(db.prepare(`INSERT INTO services (name, server_id, url, expect, group_name, position, created_at)
				VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM services), ?)`).run(
				service.name, server.id, service.url, service.expect || null, service.group || null, now).lastInsertRowid);
		},
		/** Changes what's given; an empty expected text or group removes it. */
		editService(id: number, edit: ServiceEdit) {
			const sets: [string, string | null][] = [];
			if (edit.name !== undefined) sets.push(['name', edit.name]);
			if (edit.url !== undefined) sets.push(['url', edit.url]);
			if (edit.expect !== undefined) sets.push(['expect', edit.expect || null]);
			if (edit.group !== undefined) sets.push(['group_name', edit.group || null]);
			if (!sets.length) return Boolean(db.prepare('SELECT 1 FROM services WHERE id = ?').get(id));
			return db.prepare(`UPDATE services SET ${sets.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`).run(...sets.map(([, value]) => value), id).changes > 0;
		},
		/** Puts the services in this order, each under its group; services not listed keep their place after them. */
		arrange(order: { id: number; group: string }[]) {
			transaction(() => {
				const set = db.prepare('UPDATE services SET position = ?, group_name = ? WHERE id = ?');
				order.forEach(({ id, group }, i) => set.run(i + 1, group || null, id));
				db.prepare('UPDATE services SET position = position + ? WHERE id NOT IN (SELECT value FROM json_each(?))').run(order.length, JSON.stringify(order.map(o => o.id)));
			});
		},
		removeService: (id: number) => db.prepare('DELETE FROM services WHERE id = ?').run(id).changes > 0,
		services: () => db.prepare(`SELECT v.*, s.name AS server FROM services v JOIN servers s ON s.id = v.server_id
			ORDER BY COALESCE(v.position, 1e9), v.id`).all() as ServiceRow[],
		/** What a server's agent checks: one "<id>\t<address>\t<expected text>" line per service. */
		checksFor: (serverId: number) => (db.prepare('SELECT id, url, expect FROM services WHERE server_id = ? ORDER BY id').all(serverId) as { id: number; url: string; expect: string | null }[])
			.map(s => `${s.id}\t${s.url}\t${s.expect ?? ''}\n`).join(''),

		/** Stores an agent's samples and service checks (only those of its own services). Sending them twice changes nothing. */
		record(serverId: number, samples: Sample[], checks: Check[] = []) {
			const own = new Set((db.prepare('SELECT id FROM services WHERE server_id = ?').all(serverId) as { id: number }[]).map(s => s.id));
			const mine = checks.filter(c => own.has(c.service));
			transaction(() => {
				if (samples.length) {
					const spans = spansOf(samples);
					for (const kind of ['up', 'online'] as const) for (const span of spans[kind]) serverSpans.add([serverId, kind], span, kind === 'online' ? SLACK : 0);
					const latest = samples.reduce((a, b) => (b.at > a.at ? b : a));
					const first = Math.min(...samples.map(s => s.at));
					q.seen.run(first, first, latest.at, latest.online ? 1 : 0, latest.at, latest.at, serverId);
				}
				for (const id of new Set(mine.map(c => c.service))) {
					const list = mine.filter(c => c.service === id);
					// A check that got through proves the minute before it, like an online sample.
					for (const span of merge(list.filter(c => c.ok).map(c => [c.at - MINUTE, c.at]), SLACK)) serviceSpans.add([id], span, SLACK);
					const latest = list.reduce((a, b) => (b.at > a.at ? b : a));
					const first = Math.min(...list.map(c => c.at));
					q.checked.run(first, first, latest.at, latest.ok ? 1 : 0, latest.at, latest.ms, latest.at, latest.at, id);
				}
			});
		},

		/** Forgets what's older than two years. */
		prune(now = Math.floor(Date.now() / 1000)) {
			for (const table of ['spans', 'service_spans']) {
				db.prepare(`DELETE FROM ${table} WHERE end_at <= ?`).run(now - KEEP);
				db.prepare(`UPDATE ${table} SET start_at = ? WHERE start_at < ?`).run(now - KEEP, now - KEEP);
			}
		},

		/**
		 * A server's uptime over the last year and the last 30 days (from its first sample, if later), and day by
		 * day (UTC). Seconds: `tracked` is the time looked at, `up` the time it ran, `online` the time it was online.
		 */
		uptime(server: ServerRow, now = Math.floor(Date.now() / 1000)) {
			if (server.first_at === null || server.last_at === null) return null;
			const to = until(server.last_at, now);
			const from = Math.max(now - WINDOW, server.first_at - MINUTE);
			return summarize({ up: serverSpans.within([server.id, 'up'], from, to), online: serverSpans.within([server.id, 'online'], from, to) }, from, to, now);
		},

		/** A service's uptime, likewise: it's up while its server's checks reach it and that server is online. */
		serviceUptime(service: ServiceRow, now = Math.floor(Date.now() / 1000)) {
			if (service.first_at === null || service.last_at === null) return null;
			const to = until(service.last_at, now);
			const from = Math.max(now - WINDOW, service.first_at - MINUTE);
			const up = intersect(serviceSpans.within([service.id], from, to), serverSpans.within([service.server_id, 'online'], from, to));
			return summarize({ up }, from, to, now);
		},
	};
}

export type Store = ReturnType<typeof openStore>;
