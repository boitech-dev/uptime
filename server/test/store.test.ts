// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DAY, KEEP, intersect, merge, openStore, parseReport, serviceProblem, spansOf, type Sample } from '../src/store.ts';

const fresh = () => openStore(join(mkdtempSync(join(tmpdir(), 'uptime-store-')), 'uptime.db'));
/** One sample a minute from `from` for `minutes`, booted at `boot`, online unless listed. */
const minutes = (from: number, count: number, boot: number, offline: number[] = []): Sample[] =>
	Array.from({ length: count }, (_, i) => ({ at: from + i * 60, boot, online: !offline.includes(i) }));

describe('spans', () => {
	it('merges what overlaps or nearly touches', () => {
		assert.deepEqual(merge([[50, 60], [0, 10], [5, 20], [23, 30]]), [[0, 20], [23, 30], [50, 60]]);
		assert.deepEqual(merge([[0, 10], [13, 20]], 5), [[0, 20]]);
	});

	it('a machine runs from its boot to its latest sample; online is the minute before each online sample', () => {
		const samples = [...minutes(1000, 5, 900, [2]), ...minutes(2000, 2, 1990)];
		assert.deepEqual(spansOf(samples), {
			up: [[900, 1240], [1990, 2060]],
			online: [[940, 1060], [1120, 1240], [1990, 2060]],
		});
	});

	it('reads the lines agents send, and skips the rest', () => {
		const now = 10 * 365 * DAY;
		const { samples, skipped } = parseReport(`${now - 60} ${now - 3600} 1\n\n${now} ${now - 3600} 0\nnonsense\n${now - KEEP - 1} 1 1\n${now} ${now + 5} 1\n`, now);
		assert.deepEqual(samples, [{ at: now - 60, boot: now - 3600, online: true }, { at: now, boot: now - 3600, online: false }]);
		assert.equal(skipped, 3);
		const report = parseReport(`${now} svc 7 1 152\n${now} svc 8 0 0\n${now} svc x 1 1\n`, now);
		assert.deepEqual(report.checks, [{ at: now, service: 7, ok: true, ms: 152 }, { at: now, service: 8, ok: false, ms: 0 }]);
		assert.equal(report.skipped, 1);
	});

	it('finds the time two lists have in common', () => {
		assert.deepEqual(intersect([[0, 10], [20, 30]], [[5, 25], [28, 40]]), [[5, 10], [20, 25], [28, 30]]);
		assert.deepEqual(intersect([[0, 10]], []), []);
	});

	it('takes service addresses it can check', () => {
		for (const ok of ['https://git.example.com/api/healthz', 'wss://example.com/v1/ws', 'tcp://127.0.0.1:3306']) assert.equal(serviceProblem(ok), null, ok);
		for (const bad of ['example.com', 'ftp://example.com', 'tcp://127.0.0.1', 'https://example.com/a b']) assert.ok(serviceProblem(bad), bad);
		assert.ok(serviceProblem('https://example.com', 'two\tparts'));
	});
});

describe('the store', () => {
	it('counts the time running and online, from the first sample, whatever order samples come in', () => {
		const store = fresh();
		store.addServer('web-1');
		const [server] = store.servers();
		const now = 100 * DAY;
		const start = now - 2 * DAY;
		// Two days of samples; the machine restarts after a day (down 10 minutes) and is offline for 30 minutes.
		const day1 = minutes(start, 1440, start - 3600, Array.from({ length: 30 }, (_, i) => 600 + i));
		const day2 = minutes(start + DAY + 600, 1440 - 10, start + DAY + 590);
		store.record(server.id, day2.slice(0, 700));
		store.record(server.id, day1);
		store.record(server.id, day2.slice(650)); // overlapping: sent twice
		const u = store.uptime(store.servers()[0], now)!;
		assert.equal(u.from, start - 60);
		// Up to the latest sample, a minute ago: a server that never failed shows 100%.
		assert.equal(u.year.tracked, 2 * DAY);
		// Down from day 1's last sample (start + DAY - 60) to the boot (start + DAY + 590).
		assert.equal(u.year.tracked - u.year.up, 650);
		assert.equal(u.year.tracked - u.year.online, 650 + 30 * 60);
		assert.equal(u.days.length, 3);
		assert.equal(u.days.reduce((s, d) => s + d.tracked, 0), u.year.tracked);
		// Ten minutes without news: they count as down, all of them.
		const silent = store.uptime(store.servers()[0], now + 600)!;
		assert.equal(silent.year.tracked - silent.year.up, 650 + 660);
		const s = store.servers()[0];
		assert.deepEqual([s.first_at, s.last_at, s.last_online], [start, day2.at(-1)!.at, 1]);
	});

	it('a service is up while its server’s checks reach it and that server is online', () => {
		const store = fresh();
		store.addServer('db-host');
		store.addServer('other');
		const [host, other] = store.servers();
		const id = store.addService({ name: 'MariaDB', server: 'db-host', url: 'tcp://127.0.0.1:3306', expect: 'MariaDB' })!;
		assert.equal(store.addService({ name: 'x', server: 'nobody', url: 'tcp://127.0.0.1:1' }), null);
		assert.equal(store.checksFor(host.id), `${id}\ttcp://127.0.0.1:3306\tMariaDB\n`);
		const now = 50 * DAY;
		const start = now - 60 * 60;
		// An hour: the machine is offline for minutes 20–29, the service doesn't answer for minutes 40–44.
		store.record(host.id, minutes(start, 60, start - 600, Array.from({ length: 10 }, (_, i) => 20 + i)),
			Array.from({ length: 60 }, (_, i) => ({ at: start + i * 60, service: id, ok: i < 40 || i > 44, ms: 3 })));
		// Another server can't report for it.
		store.record(other.id, [], [{ at: now, service: id, ok: false, ms: 0 }]);
		const service = store.services()[0];
		assert.deepEqual([service.server, service.last_ok, service.last_ms, service.last_at], ['db-host', 1, 3, start + 59 * 60]);
		const u = store.serviceUptime(service, now)!;
		assert.equal(u.year.tracked, 60 * 60);
		assert.equal(u.year.tracked - u.year.up, (10 + 5) * 60, 'offline minutes and failed checks');
		assert.ok(store.removeService(id));
		assert.equal(store.checksFor(host.id), '');
	});

	it('keeps services in the order and groups they’re given; edits change only what’s given', () => {
		const store = fresh();
		store.addServer('web');
		const [a, b, c] = ['A', 'B', 'C'].map(name => store.addService({ name, server: 'web', url: 'https://example.com/' })!);
		assert.deepEqual(store.services().map(s => s.name), ['A', 'B', 'C'], 'in the order added');
		store.arrange([{ id: c, group: 'Mail' }, { id: a, group: '' }]);
		assert.deepEqual(store.services().map(s => [s.name, s.group_name]), [['C', 'Mail'], ['A', null], ['B', null]], 'B, not listed, after them');
		assert.ok(store.editService(b, { name: 'B2', group: 'Mail', expect: 'ok' }));
		const b2 = store.services().find(s => s.id === b)!;
		assert.deepEqual([b2.name, b2.group_name, b2.expect, b2.url], ['B2', 'Mail', 'ok', 'https://example.com/']);
		store.editService(b, { expect: '', group: '' });
		assert.deepEqual([store.services().find(s => s.id === b)!.expect, store.services().find(s => s.id === b)!.group_name], [null, null]);
		assert.equal(store.editService(999, { name: 'x' }), false);
	});

	it('forgets what’s older than two years', () => {
		const store = fresh();
		store.addServer('old');
		const [server] = store.servers();
		const now = 1000 * DAY;
		store.record(server.id, [{ at: now - KEEP - DAY, boot: now - KEEP - 2 * DAY, online: true }, { at: now - KEEP + DAY, boot: now - KEEP - 2 * DAY, online: true }]);
		store.prune(now);
		const spans = store.db.prepare("SELECT start_at, end_at FROM spans WHERE kind = 'up'").all();
		assert.deepEqual(spans.map(r => [r.start_at, r.end_at]), [[now - KEEP, now - KEEP + DAY]]);
	});

	it('manages servers: tokens, renames, removal', () => {
		const store = fresh();
		const token = store.addServer('web-1');
		assert.match(token, /^upt_[\w-]{43}$/);
		assert.equal(store.serverByToken(token)?.name, 'web-1');
		assert.throws(() => store.addServer('web-1'));
		const next = store.newToken('web-1')!;
		assert.equal(store.serverByToken(token), undefined);
		assert.equal(store.serverByToken(next)?.name, 'web-1');
		assert.equal(store.newToken('nope'), null);
		assert.ok(store.rename('web-1', 'web-2'));
		assert.ok(store.remove('web-2'));
		assert.deepEqual(store.servers(), []);
	});
});
