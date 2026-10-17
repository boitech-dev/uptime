// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp, hashPassword } from '../src/http.ts';
import { openStore } from '../src/store.ts';

const store = openStore(join(mkdtempSync(join(tmpdir(), 'uptime-http-')), 'uptime.db'));
const app = createApp({ store, user: 'admin', passwordHash: hashPassword('correct horse battery'), url: 'https://uptime.test' });
let base = '';
const login = { authorization: `Basic ${Buffer.from('admin:correct horse battery').toString('base64')}` };

before(async () => {
	await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => app.close());

describe('the dashboard', () => {
	it('asks for the password, and only the right one opens it', async () => {
		const none = await fetch(`${base}/`);
		assert.equal(none.status, 401);
		assert.match(none.headers.get('www-authenticate')!, /^Basic realm="Uptime"/);
		const wrong = await fetch(`${base}/api/servers`, { headers: { authorization: `Basic ${Buffer.from('admin:guess').toString('base64')}` } });
		assert.equal(wrong.status, 401);
		const page = await fetch(`${base}/`, { headers: login });
		assert.equal(page.status, 200);
		assert.match(await page.text(), /<title>Uptime<\/title>/);
		assert.match(page.headers.get('content-security-policy')!, /default-src 'self'/);
		assert.equal((await fetch(`${base}/health`)).status, 200);
		assert.equal((await fetch(`${base}/nowhere`, { headers: login })).status, 404);
	});

	it('serves the agent and its installer to anyone', async () => {
		assert.match(await (await fetch(`${base}/agent/install.sh`)).text(), /uptime-agent\.timer/);
		assert.match(await (await fetch(`${base}/agent/uptime-agent`)).text(), /api\/report/);
	});

	it('adds a server from the page, and gives the line that installs its agent', async () => {
		const add = (body: unknown, headers: Record<string, string> = {}) =>
			fetch(`${base}/api/servers`, { method: 'POST', headers: { ...login, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
		const res = await add({ name: 'web-1' });
		assert.equal(res.status, 201);
		const { name, command } = await res.json() as { name: string; command: string };
		assert.equal(name, 'web-1');
		assert.match(command, /^curl -fsSL https:\/\/uptime\.test\/agent\/install\.sh \| sudo UPTIME_URL=https:\/\/uptime\.test UPTIME_TOKEN=upt_[\w-]+ sh$/);
		assert.equal((await add({ name: 'web-1' })).status, 409);
		assert.equal((await add({ name: ' ' })).status, 400);
		assert.equal((await add({ name: 'x' }, { origin: 'https://elsewhere.test' })).status, 403, 'not from another site');
		assert.equal((await fetch(`${base}/api/servers`, { method: 'POST', headers: { ...login, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' })).status, 403);
		assert.equal((await fetch(`${base}/api/servers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status, 401);
	});

	it('takes an agent’s report with its token, and shows the server’s uptime', async () => {
		const token = store.addServer('web-2');
		const now = Math.floor(Date.now() / 1000);
		const report = (body: string, auth = `Bearer ${token}`) => fetch(`${base}/api/report`, { method: 'POST', headers: { authorization: auth }, body });
		assert.equal((await report('1 1 1', 'Bearer upt_wrong')).status, 401);
		const lines = [3, 2, 1].map(ago => `${now - ago * 60} ${now - 3600} ${ago === 2 ? 0 : 1}`).join('\n');
		const res = await report(`${lines}\ngarbage\n`);
		assert.deepEqual(await res.json(), { accepted: 3, skipped: 1 });
		assert.equal((await report('x'.repeat(1024 * 1024 + 1))).status, 413);

		const { servers } = await (await fetch(`${base}/api/servers`, { headers: login })).json() as { servers: { name: string; lastOnline: boolean; uptime: { year: { tracked: number; up: number; online: number } } }[] };
		const web2 = servers.find(s => s.name === 'web-2')!;
		assert.equal(web2.lastOnline, true);
		assert.ok(web2.uptime.year.tracked >= 180 && web2.uptime.year.up >= 180);
		assert.ok(web2.uptime.year.tracked - web2.uptime.year.online >= 60, 'the offline minute');
	});
});

describe('wrong passwords', () => {
	it('past 20 a minute, everyone waits', async () => {
		const guess = { authorization: `Basic ${Buffer.from('admin:guess').toString('base64')}` };
		let last = 0;
		for (let i = 0; i < 21; i++) last = (await fetch(`${base}/`, { headers: guess })).status;
		assert.equal(last, 429);
		assert.equal((await fetch(`${base}/`, { headers: login })).status, 429);
	});

	it('a dashboard needs a login, unless it’s meant to be open', () => {
		assert.throws(() => createApp({ store }), /UPTIME_USER/);
		assert.doesNotThrow(() => createApp({ store, open: true }));
	});
});
