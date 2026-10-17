// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard page: every server's uptime, refreshed every minute. No framework, no build.

const DAY = 86_400;
/** A server is "silent" when its latest sample is older than this. */
const STALE = 180;
const DAYS = 365;

const el = (tag, props = {}, ...children) => {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
	return node;
};
const svgEl = (tag, attrs = {}) => {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	return node;
};

/** Floored, so 99.9996 % never shows as 100 %. */
const percent = (part, whole) => (whole > 0 ? Math.floor((100_000 * part) / whole) / 1000 : null);
const showPercent = value => (value === null ? '—' : value === 100 ? '100%' : `${value.toFixed(3)}%`);

function duration(seconds) {
	const minutes = Math.round(seconds / 60);
	if (minutes < 1) return `${Math.max(1, Math.round(seconds))} s`;
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
	return `${Math.floor(hours / 24)} days`;
}

const dateText = (unix, options = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(unix * 1000).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
const timeText = unix => new Date(unix * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function stateOf(server, now) {
	if (!server.lastAt) return { key: 'silent', label: 'Waiting for its first sample', detail: 'Install its agent to start' };
	const age = now - server.lastAt;
	const latest = `Latest sample ${duration(age)} ago`;
	if (age > STALE) return { key: 'silent', label: `No news for ${duration(age)}`, detail: 'Down, or can’t reach the dashboard' };
	return server.lastOnline ? { key: 'online', label: 'Online', detail: latest } : { key: 'offline', label: 'Running, offline', detail: latest };
}

/** A spike's height for a day's downtime: a minute shows, a whole day reaches the top. */
const spike = seconds => (seconds <= 0 ? 0 : 6 + 34 * Math.min(1, Math.log1p(seconds / 60) / Math.log1p(1440)));

/** The year as a seismograph: a flat line on calm days, a spike where the machine was down (red) or offline (amber). */
function trace(server, now) {
	const first = Math.floor(now / DAY) * DAY - (DAYS - 1) * DAY;
	const byDay = new Map((server.uptime?.days ?? []).map(d => [d.day, d]));
	const days = Array.from({ length: DAYS }, (_, i) => ({ day: first + i * DAY, data: byDay.get(first + i * DAY) }));
	const base = 46;
	const svg = svgEl('svg', { viewBox: `0 0 ${DAYS} 48`, preserveAspectRatio: 'none', role: 'img' });
	let offline = '';
	let down = '';
	// The baseline in stretches, so a dotted one keeps its rhythm: dotted while not tracked, solid after.
	const runs = [];
	days.forEach(({ data }, i) => {
		const kind = data?.tracked ? 'baseline' : 'untracked';
		if (runs.at(-1)?.kind === kind) runs.at(-1).end = i + 1;
		else runs.push({ kind, start: i, end: i + 1 });
		if (kind === 'untracked') return;
		const x = i + 0.5;
		const off = spike(data.tracked - data.online);
		const dn = spike(data.tracked - data.up);
		if (off) offline += `M${x} ${base}V${base - off}`;
		if (dn) down += `M${x} ${base}V${base - dn}`;
	});
	const line = kind => runs.filter(r => r.kind === kind).map(r => `M${r.start} ${base}H${r.end}`).join('');
	for (const [d, cls] of [[line('untracked'), 'untracked'], [line('baseline'), 'baseline'], [offline, 'spike-offline'], [down, 'spike-down']]) {
		if (d) svg.append(svgEl('path', { d, class: cls, 'vector-effect': 'non-scaling-stroke', fill: 'none' }));
	}
	const cursor = svgEl('line', { class: 'cursor', y1: 0, y2: base, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
	svg.append(cursor);

	const bad = days.filter(d => d.data && d.data.tracked - d.data.online > 0);
	svg.setAttribute('aria-label', bad.length ? `Over the last ${DAYS} days, ${bad.length} days with downtime or time offline.` : `No downtime and no time offline over the time tracked.`);

	const tip = document.getElementById('tip');
	const show = event => {
		const box = svg.getBoundingClientRect();
		const i = Math.min(DAYS - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * DAYS)));
		const { day, data } = days[i];
		cursor.setAttribute('x1', i + 0.5);
		cursor.setAttribute('x2', i + 0.5);
		cursor.setAttribute('visibility', 'visible');
		const lines = !data || !data.tracked
			? ['Not tracked yet']
			: data.tracked - data.online <= 0
				? ['Running and online the whole time']
				: [data.tracked - data.up > 0 ? `Machine down for ${duration(data.tracked - data.up)}` : 'Machine running the whole time', `Offline for ${duration(data.tracked - data.online)}`];
		tip.replaceChildren(el('strong', { textContent: dateText(day, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) }), ...lines.map(l => el('div', { textContent: l })));
		tip.hidden = false;
		const x = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, event.clientX - tip.offsetWidth / 2));
		tip.style.left = `${x}px`;
		tip.style.top = `${box.top - tip.offsetHeight - 8}px`;
	};
	const hide = () => {
		tip.hidden = true;
		cursor.setAttribute('visibility', 'hidden');
	};
	svg.addEventListener('pointermove', show);
	svg.addEventListener('pointerdown', show);
	svg.addEventListener('pointerleave', hide);

	const since = server.uptime?.from;
	return el('div', { className: 'trace' },
		svg,
		el('div', { className: 'axis' },
			el('span', { textContent: dateText(first) }),
			since && since > first ? el('span', { textContent: `Tracked since ${dateText(since)}` }) : null,
			el('span', { textContent: 'Today' })));
}

function figure(label, part, whole, monthPart, monthWhole) {
	return el('div', { className: 'figure' },
		el('dt', { textContent: label }),
		el('dd', {},
			el('span', { className: 'year', textContent: showPercent(percent(part, whole)) }),
			el('span', { className: 'month', textContent: `30 days: ${showPercent(percent(monthPart, monthWhole))}` })));
}

function serverSection(server, now) {
	const state = stateOf(server, now);
	const u = server.uptime;
	return el('section', { className: `server ${state.key}` },
		el('div', { className: 'server-head' },
			el('h2', { textContent: server.name }),
			el('p', { className: 'state' }, el('span', { className: 'dot' }), el('strong', { textContent: state.label }), el('span', { textContent: state.detail }))),
		u
			? el('dl', { className: 'figures' },
				figure('Machine', u.year.up, u.year.tracked, u.month.up, u.month.tracked),
				figure('Machine and network', u.year.online, u.year.tracked, u.month.online, u.month.tracked))
			: null,
		trace(server, now));
}

function headline(servers, now) {
	if (!servers.length) return 'No servers yet';
	const online = servers.filter(s => stateOf(s, now).key === 'online').length;
	if (online === servers.length) return servers.length === 1 ? `${servers[0].name} is online` : `All ${servers.length} servers online`;
	return `${online} of ${servers.length} servers online`;
}

async function load() {
	const main = document.getElementById('servers');
	try {
		const response = await fetch('/api/servers', { cache: 'no-store' });
		if (!response.ok) throw new Error(`the dashboard answered ${response.status}`);
		const { now, servers } = await response.json();
		document.getElementById('headline').textContent = headline(servers, now);
		document.getElementById('updated').textContent = `Updated at ${timeText(now)}.`;
		main.replaceChildren(...(servers.length
			? servers.map(s => serverSection(s, now))
			: [el('p', { className: 'empty', textContent: 'Add your first server below: you’ll get the one line to run on it.' })]));
	} catch (error) {
		main.replaceChildren(el('p', { className: 'error', textContent: `Couldn’t load the servers: ${error.message}. Trying again in a minute.` }));
	}
}

// Adding a server: the dashboard answers the one line that installs its agent.
document.getElementById('add-form').addEventListener('submit', async event => {
	event.preventDefault();
	const input = document.getElementById('add-name');
	const error = document.getElementById('add-error');
	error.hidden = true;
	const response = await fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: input.value }) }).catch(() => null);
	if (!response?.ok) {
		error.textContent = response ? await response.text() : 'The dashboard can’t be reached. Check your connection and try again.';
		error.hidden = false;
		return;
	}
	const { name, command } = await response.json();
	document.getElementById('add-server').textContent = name;
	document.getElementById('add-command').textContent = command;
	document.getElementById('add-result').hidden = false;
	input.value = '';
	load();
});
document.getElementById('add-copy').addEventListener('click', async event => {
	await navigator.clipboard.writeText(document.getElementById('add-command').textContent);
	event.target.textContent = 'Copied';
	setTimeout(() => (event.target.textContent = 'Copy command'), 2000);
});

load();
setInterval(load, 60_000);
