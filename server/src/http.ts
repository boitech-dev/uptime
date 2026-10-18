// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The dashboard's HTTP side:
 *   POST /api/report          agents send their samples and service checks (Bearer token), as text lines
 *   GET  /api/checks          the services an agent checks (Bearer token), as text lines
 *   GET  /api/servers         every server's and service's uptime, for the dashboard page (password)
 *   POST /api/servers         adds a server: answers the one-line command that installs its agent (password)
 *   POST /api/services        adds a service to the server it runs on (password)
 *   PATCH /api/services/<id>  renames a service, changes its address, expected text or group (password)
 *   PUT  /api/services/order  puts the services in an order, each under its group (password)
 *   DELETE /api/services/<id> removes a service and its history (password)
 *   GET  /agent/install.sh, /agent/uptime-agent    the agent, to install it (public: it's free software)
 *   GET  /health              for monitoring
 *   GET  /                    the dashboard page (password)
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { parseReport, serviceProblem, type ServiceEdit, type Store } from './store.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.sh': 'text/plain; charset=utf-8', '': 'text/plain; charset=utf-8' };
const FILES: Record<string, string> = {
	'/': 'server/public/index.html',
	'/app.js': 'server/public/app.js',
	'/style.css': 'server/public/style.css',
	'/favicon.svg': 'server/public/favicon.svg',
};
const AGENT: Record<string, string> = { '/agent/install.sh': 'agent/install.sh', '/agent/uptime-agent': 'agent/uptime-agent' };
const MAX_REPORT = 1024 * 1024;

/** A password hash for UPTIME_PASSWORD_HASH: scrypt, as "scrypt:<salt>:<hash>" (base64url). */
export function hashPassword(password: string, salt = randomBytes(16).toString('base64url')) {
	return `scrypt:${salt}:${scryptSync(password, salt, 32).toString('base64url')}`;
}

function passwordMatches(password: string, hash: string) {
	const [scheme, salt, expected] = hash.split(':');
	if (scheme !== 'scrypt' || !salt || !expected) return false;
	const actual = scryptSync(password, salt, 32);
	const wanted = Buffer.from(expected, 'base64url');
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export type Options = {
	store: Store;
	/** The dashboard's login; without one, the dashboard is only open when `open` is set. */
	user?: string;
	passwordHash?: string;
	open?: boolean;
	/** The dashboard's public address, for install commands (default: https:// and the Host the request came to). */
	url?: string;
};

/** The one line that installs a server's agent. */
export const installCommand = (url: string, token: string) => `curl -fsSL ${url}/agent/install.sh | sudo UPTIME_URL=${url} UPTIME_TOKEN=${token} sh`;

export function createApp({ store, user, passwordHash, open = false, url }: Options) {
	if (!open && !(user && passwordHash)) throw new Error('Set UPTIME_USER and UPTIME_PASSWORD_HASH, or UPTIME_OPEN=1 for a dashboard without a password.');
	// Wrong passwords, all visitors together: past 20 a minute, everyone waits (the proxy hides who's who).
	let failures = 0;
	let failuresSince = Date.now();

	function authorized(req: IncomingMessage, res: ServerResponse) {
		if (open) return true;
		if (Date.now() - failuresSince > 60_000) [failures, failuresSince] = [0, Date.now()];
		if (failures >= 20) {
			send(res, 429, 'Too many wrong passwords: try again in a minute.', { 'retry-after': '60' });
			return false;
		}
		const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
		if (scheme === 'Basic' && encoded) {
			const decoded = Buffer.from(encoded, 'base64').toString();
			const colon = decoded.indexOf(':');
			if (colon > 0 && decoded.slice(0, colon) === user && passwordMatches(decoded.slice(colon + 1), passwordHash!)) return true;
			failures++;
		}
		send(res, 401, 'Sign in to see the dashboard.', { 'www-authenticate': 'Basic realm="Uptime", charset="UTF-8"' });
		return false;
	}

	/** The agent's server, from its token. */
	const agentServer = (req: IncomingMessage) => {
		const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
		return token ? store.serverByToken(token) : undefined;
	};

	async function report(req: IncomingMessage, res: ServerResponse) {
		const server = agentServer(req);
		if (!server) return send(res, 401, 'Unknown token.');
		const body = await read(req, MAX_REPORT);
		if (body === null) return send(res, 413, 'At most 1 MB per report.');
		const { samples, checks, skipped } = parseReport(body, Math.floor(Date.now() / 1000));
		store.record(server.id, samples, checks);
		send(res, 200, JSON.stringify({ accepted: samples.length + checks.length, skipped }), { 'content-type': 'application/json' });
	}

	/**
	 * A change from the page, as JSON. Browsers send the password along on their own: only a same-origin request
	 * may change anything (a JSON body or a DELETE from another site needs a preflight this server never answers).
	 */
	async function fromPage(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
		const origin = req.headers.origin;
		const json = (req.headers['content-type'] ?? '').startsWith('application/json');
		if ((req.method !== 'DELETE' && !json) || (origin && URL.parse(origin)?.host !== req.headers.host)) {
			send(res, 403, 'Make changes from the dashboard.');
			return null;
		}
		const body = await read(req, 10_000);
		if (body === null) {
			send(res, 413, 'Too long.');
			return null;
		}
		try {
			const parsed = JSON.parse(body || '{}');
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

	async function addServer(req: IncomingMessage, res: ServerResponse) {
		const body = await fromPage(req, res);
		if (!body) return;
		const name = text(body.name);
		if (!name || name.length > 80) return send(res, 400, 'Give the server a name, up to 80 characters.');
		let token: string;
		try {
			token = store.addServer(name);
		} catch {
			return send(res, 409, `There's already a server called ${name}.`);
		}
		send(res, 201, JSON.stringify({ name, command: installCommand(url ?? `https://${req.headers.host}`, token) }), { 'content-type': 'application/json' });
	}

	const GROUP = 'A group name is up to 60 characters.';
	const NAME = 'Give the service a name, up to 80 characters.';

	async function addService(req: IncomingMessage, res: ServerResponse) {
		const body = await fromPage(req, res);
		if (!body) return;
		const [name, server, address, expect, group] = [text(body.name), text(body.server), text(body.url), text(body.expect), text(body.group)];
		if (!name || name.length > 80) return send(res, 400, NAME);
		if (group.length > 60) return send(res, 400, GROUP);
		const problem = serviceProblem(address, expect);
		if (problem) return send(res, 400, problem);
		const id = store.addService({ name, server, url: address, expect, group });
		if (id === null) return send(res, 400, 'Choose the server it runs on.');
		send(res, 201, JSON.stringify({ id }), { 'content-type': 'application/json' });
	}

	async function editService(req: IncomingMessage, res: ServerResponse, id: number) {
		const body = await fromPage(req, res);
		if (!body) return;
		const current = store.services().find(s => s.id === id);
		if (!current) return send(res, 404, 'This service doesn’t exist anymore.');
		const edit: ServiceEdit = {};
		for (const field of ['name', 'url', 'expect', 'group'] as const) if (typeof body[field] === 'string') edit[field] = text(body[field]);
		if (edit.name !== undefined && (!edit.name || edit.name.length > 80)) return send(res, 400, NAME);
		if ((edit.group?.length ?? 0) > 60) return send(res, 400, GROUP);
		const problem = serviceProblem(edit.url ?? current.url, edit.expect ?? current.expect ?? '');
		if (problem) return send(res, 400, problem);
		store.editService(id, edit);
		send(res, 204, '');
	}

	async function arrange(req: IncomingMessage, res: ServerResponse) {
		const body = await fromPage(req, res);
		if (!body) return;
		const order = Array.isArray(body.order) ? body.order : null;
		const valid = order?.every(o => o && Number.isInteger(o.id) && typeof o.group === 'string' && o.group.trim().length <= 60);
		if (!order || !valid || order.length > 10_000) return send(res, 400, 'Send the order as a list of { id, group }.');
		store.arrange(order.map(o => ({ id: o.id, group: o.group.trim() })));
		send(res, 204, '');
	}

	async function removeService(req: IncomingMessage, res: ServerResponse, id: number) {
		if (!(await fromPage(req, res))) return;
		send(res, store.removeService(id) ? 204 : 404, '');
	}

	function servers(res: ServerResponse) {
		const now = Math.floor(Date.now() / 1000);
		const list = store.servers().map(s => ({
			name: s.name, firstAt: s.first_at, lastAt: s.last_at, lastOnline: s.last_online === null ? null : s.last_online === 1,
			uptime: store.uptime(s, now),
		}));
		const services = store.services().map(s => ({
			id: s.id, name: s.name, server: s.server, url: s.url, expect: s.expect, group: s.group_name, lastAt: s.last_at, lastOk: s.last_ok === null ? null : s.last_ok === 1,
			lastMs: s.last_ms, uptime: store.serviceUptime(s, now),
		}));
		send(res, 200, JSON.stringify({ now, servers: list, services }), { 'content-type': 'application/json', 'cache-control': 'no-store' });
	}

	return createServer(async (req, res) => {
		try {
			const path = new URL(req.url ?? '/', 'http://x').pathname;
			if (req.method === 'POST' && path === '/api/report') return await report(req, res);
			if (req.method === 'GET' && path === '/api/checks') {
				const server = agentServer(req);
				return server ? send(res, 200, store.checksFor(server.id)) : send(res, 401, 'Unknown token.');
			}
			if (req.method === 'POST' && path === '/api/servers') return authorized(req, res) ? await addServer(req, res) : undefined;
			if (req.method === 'POST' && path === '/api/services') return authorized(req, res) ? await addService(req, res) : undefined;
			if (req.method === 'PUT' && path === '/api/services/order') return authorized(req, res) ? await arrange(req, res) : undefined;
			const serviceId = /^\/api\/services\/(\d{1,9})$/.exec(path)?.[1];
			if (req.method === 'DELETE' && serviceId) return authorized(req, res) ? await removeService(req, res, Number(serviceId)) : undefined;
			if (req.method === 'PATCH' && serviceId) return authorized(req, res) ? await editService(req, res, Number(serviceId)) : undefined;
			if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.');
			if (path === '/health') return send(res, 200, 'ok');
			if (AGENT[path]) return file(res, AGENT[path]);
			if (!FILES[path] && path !== '/api/servers') return send(res, 404, 'Not found.');
			if (!authorized(req, res)) return;
			if (path === '/api/servers') return servers(res);
			return file(res, FILES[path]);
		} catch (error) {
			console.error(error);
			if (!res.headersSent) send(res, 500, 'Something went wrong.');
		}
	});
}

const SECURITY = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/** The request's body, or null past `limit` characters. */
async function read(req: IncomingMessage, limit: number) {
	let body = '';
	for await (const chunk of req) {
		body += chunk;
		if (body.length > limit) return null;
	}
	return body;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
	res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY, ...headers }).end(body);
}

function file(res: ServerResponse, path: string) {
	send(res, 200, readFileSync(join(ROOT, path), 'utf8'), { 'content-type': TYPES[extname(path)] ?? TYPES[''], 'cache-control': 'no-cache' });
}
