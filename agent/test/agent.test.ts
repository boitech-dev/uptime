// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

const AGENT = new URL('../uptime-agent', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'uptime-agent-'));
/** What the fake dashboard received, and whether it's up. */
const received: { auth: string | undefined; body: string }[] = [];
let up = true;
const dashboard = createServer((req, res) => {
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		if (!up || req.url !== '/api/report') return res.writeHead(503).end();
		received.push({ auth: req.headers.authorization, body });
		res.end('{}');
	});
});

before(() => new Promise<void>(resolve => dashboard.listen(0, '127.0.0.1', resolve)));
after(() => dashboard.close());

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
});
