// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

const AGENT = new URL('../uptime-agent', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'uptime-agent-'));
/** What the fake dashboard received, and whether it's up. */
const received: { auth: string | undefined; body: string }[] = [];
let up = true;
/** What GET /api/checks answers: one "<id>\t<address>\t<expected text>" line per service. */
let checks = '';
const dashboard = createServer((req, res) => {
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		if (up && req.url === '/api/checks' && req.headers.authorization === 'Bearer upt_test') return res.end(checks);
		if (!up || req.url !== '/api/report') return res.writeHead(503).end();
		received.push({ auth: req.headers.authorization, body });
		res.end('{}');
	});
});
/** The services: a web page, a WebSocket server, a database-like server that greets, and a closed port. */
const web = createServer((req, res) => (req.url === '/health' ? res.end('{"status":"pass"}') : res.writeHead(404).end('nope')));
web.on('upgrade', (_req, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
const database = createTcpServer(socket => socket.write('J\0\0\0\n5.5.5-10.11.6-MariaDB\0'));
const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;

before(async () => {
	for (const server of [dashboard, web, database]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(() => [dashboard, web, database].forEach(s => s.close()));

async function tick(hosts: string) {
	const conf = join(work, 'agent.conf');
	writeFileSync(conf, `UPTIME_URL=http://127.0.0.1:${(dashboard.address() as AddressInfo).port}\nUPTIME_TOKEN=upt_test\nUPTIME_HOSTS="${hosts}"\n`);
	await promisify(execFile)('sh', [AGENT], { env: { PATH: process.env.PATH, UPTIME_CONF: conf, UPTIME_STATE: work } });
}
const outbox = () => readFileSync(join(work, 'outbox'), 'utf8');

describe('the agent', () => {
	it('records a sample a tick, keeps them while the dashboard is away, then sends them all', async () => {
		const boot = readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m)![1];
		up = false;
		await tick('127.0.0.1');
		await tick('192.0.2.1'); // TEST-NET: never answers
		const kept = outbox().trim().split('\n');
		assert.equal(kept.length, 2);
		assert.match(kept[0], new RegExp(`^\\d+ ${boot} 1$`));
		assert.match(kept[1], new RegExp(`^\\d+ ${boot} 0$`));
		assert.equal(received.length, 0);

		up = true;
		await tick('192.0.2.1 127.0.0.1');
		assert.equal(received.length, 1);
		assert.equal(received[0].auth, 'Bearer upt_test');
		assert.deepEqual(received[0].body.trim().split('\n').map(l => l.split(' ')[2]), ['1', '0', '1']);
		assert.equal(outbox(), '', 'sent: the outbox is empty');
	});

	it('checks the services the dashboard lists, side by side, and keeps the list while the dashboard is away', async () => {
		checks = [
			`1\thttp://127.0.0.1:${port(web)}/health\tpass`,
			`2\thttp://127.0.0.1:${port(web)}/health\tabsent`,
			`3\tws://127.0.0.1:${port(web)}/live\t`,
			`4\ttcp://127.0.0.1:${port(database)}\tMariaDB`,
			`5\ttcp://127.0.0.1:1\t`,
			`6\thttp://127.0.0.1:${port(web)}/missing\t`,
		].map(l => `${l}\n`).join('');
		received.length = 0;
		await tick('127.0.0.1');
		const lines = received[0].body.trim().split('\n').filter(l => l.includes(' svc '));
		const result = Object.fromEntries(lines.map(l => l.split(' ')).map(([, , id, ok]) => [id, ok]));
		assert.deepEqual(result, { 1: '1', 2: '0', 3: '1', 4: '1', 5: '0', 6: '0' }, lines.join(' | '));
		assert.ok(lines.every(l => /^\d+ svc \d+ [01] \d+$/.test(l)), lines.join(' | '));

		// The dashboard is away: the same services are checked from the list it gave last.
		up = false;
		checks = '';
		await tick('127.0.0.1');
		assert.equal(outbox().split('\n').filter(l => l.includes(' svc ')).length, 6);
		up = true;
	});
});
