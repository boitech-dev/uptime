// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DAY, KEEP, merge, openStore, parseReport, spansOf, type Sample } from '../src/store.ts';

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
