// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The dashboard's HTTP side:
 *   POST /api/report          agents send their samples (Bearer token), as text lines
 *   GET  /api/servers         every server's uptime, for the dashboard page (password)
 *   POST /api/servers         adds a server: answers the one-line command that installs its agent (password)
 *   GET  /agent/install.sh, /agent/uptime-agent    the agent, to install it (public: it's free software)
 *   GET  /health              for monitoring
 *   GET  /                    the dashboard page (password)
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { parseReport, type Store } from './store.ts';

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

	async function report(req: IncomingMessage, res: ServerResponse) {
		const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
		const server = token && store.serverByToken(token);
		if (!server) return send(res, 401, 'Unknown token.');
		let body = '';
		for await (const chunk of req) {
			body += chunk;
			if (body.length > MAX_REPORT) return send(res, 413, 'At most 1 MB per report.');
		}
		const { samples, skipped } = parseReport(body, Math.floor(Date.now() / 1000));
		store.record(server.id, samples);
		send(res, 200, JSON.stringify({ accepted: samples.length, skipped }), { 'content-type': 'application/json' });
	}

	async function addServer(req: IncomingMessage, res: ServerResponse) {
		// Browsers send the password along on their own: only a same-origin JSON request may add a server.
		const origin = req.headers.origin;
		const sameOrigin = !origin || URL.parse(origin)?.host === req.headers.host;
		if (!(req.headers['content-type'] ?? '').startsWith('application/json') || !sameOrigin) return send(res, 403, 'Add servers from the dashboard.');
		let body = '';
		for await (const chunk of req) {
			body += chunk;
			if (body.length > 10_000) return send(res, 413, 'Too long.');
		}
		let name = '';
		try {
			name = String(JSON.parse(body).name ?? '').trim();
		} catch { /* not JSON: no name */ }
		if (!name || name.length > 80) return send(res, 400, 'Give the server a name, up to 80 characters.');
		let token: string;
		try {
			token = store.addServer(name);
		} catch {
			return send(res, 409, `There's already a server called ${name}.`);
		}
		send(res, 201, JSON.stringify({ name, command: installCommand(url ?? `https://${req.headers.host}`, token) }), { 'content-type': 'application/json' });
	}

	function servers(res: ServerResponse) {
		const now = Math.floor(Date.now() / 1000);
		const list = store.servers().map(s => ({
			name: s.name, firstAt: s.first_at, lastAt: s.last_at, lastOnline: s.last_online === null ? null : s.last_online === 1,
			uptime: store.uptime(s, now),
		}));
		send(res, 200, JSON.stringify({ now, servers: list }), { 'content-type': 'application/json', 'cache-control': 'no-store' });
	}

	return createServer(async (req, res) => {
		try {
			const path = new URL(req.url ?? '/', 'http://x').pathname;
			if (req.method === 'POST' && path === '/api/report') return await report(req, res);
			if (req.method === 'POST' && path === '/api/servers') return authorized(req, res) ? await addServer(req, res) : undefined;
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

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
	res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY, ...headers }).end(body);
}

function file(res: ServerResponse, path: string) {
	send(res, 200, readFileSync(join(ROOT, path), 'utf8'), { 'content-type': TYPES[extname(path)] ?? TYPES[''], 'cache-control': 'no-cache' });
}
