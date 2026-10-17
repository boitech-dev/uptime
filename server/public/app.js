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

/** How strongly a day with downtime is shaded: a minute shows, a whole day is solid. */
const depth = seconds => Math.round(30 + 70 * Math.min(1, Math.log1p(seconds / 60) / Math.log1p(1440)));
const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

/** What a day's tooltip says. */
function dayLines(data) {
	if (!data || !data.tracked) return ['Not tracked yet'];
	if (data.tracked - data.online <= 0) return ['Running and online the whole time'];
	const down = data.tracked - data.up;
	return [down > 0 ? `Machine down for ${duration(down)}` : 'Machine running the whole time', `Offline for ${duration(data.tracked - data.online)}`];
}

/**
 * The year as a grid, like GitHub's: a column per week (Monday first), a square per day. Calm days are pale green;
 * a day with downtime is red if the machine was down, amber if it ran but was offline, the more opaque the longer.
 */
function yearGrid(server, now) {
	const today = Math.floor(now / DAY) * DAY;
	const first = today - (DAYS - 1) * DAY;
	const start = first - ((first / DAY + 3) % 7) * DAY; // the Monday before (1970-01-01 was a Thursday)
	const weeks = Math.floor((today - start) / DAY / 7) + 1;
	const byDay = new Map((server.uptime?.days ?? []).map(d => [d.day, d]));

	const days = el('div', { className: 'days', role: 'img' });
	const months = el('div', { className: 'months', ariaHidden: 'true' });
	days.style.setProperty('--weeks', weeks);
	months.style.setProperty('--weeks', weeks);
	let bad = 0;
	for (let day = start; day <= today; day += DAY) {
		const cell = el('span', { className: 'day' });
		cell.dataset.day = day;
		const data = byDay.get(day);
		if (day < first) cell.classList.add('outside');
		else if (!data?.tracked) cell.classList.add('untracked');
		else if (data.tracked - data.online > 0) {
			bad++;
			cell.classList.add(data.tracked - data.up > 0 ? 'down' : 'offline');
			cell.style.setProperty('--depth', `${depth(data.tracked - data.online)}%`);
		} else cell.classList.add('calm');
		days.append(cell);
	}
	// A month's name over the first week that starts in it.
	for (let week = 1; week < weeks; week++) {
		const monday = start + week * 7 * DAY;
		if (new Date(monday * 1000).getUTCMonth() === new Date((monday - 7 * DAY) * 1000).getUTCMonth()) continue;
		const label = el('span', { textContent: dateText(monday, { month: 'short' }) });
		label.style.gridColumn = `${week + 1} / span 4`;
		months.append(label);
	}
	days.setAttribute('aria-label', bad ? `Over the last ${DAYS} days, ${bad} days with downtime or time offline.` : 'No downtime and no time offline over the time tracked.');

	const tip = document.getElementById('tip');
	let shown = null;
	const show = event => {
		const cell = event.target.closest('.day:not(.outside)');
		if (!cell || cell === shown) return;
		shown?.classList.remove('hover');
		shown = cell;
		cell.classList.add('hover');
		const day = Number(cell.dataset.day);
		tip.replaceChildren(el('strong', { textContent: dateText(day, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) }), ...dayLines(byDay.get(day)).map(l => el('div', { textContent: l })));
		tip.hidden = false;
		const box = cell.getBoundingClientRect();
		tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
		tip.style.top = `${box.top - tip.offsetHeight - 8}px`;
	};
	const hide = () => {
		shown?.classList.remove('hover');
		shown = null;
		tip.hidden = true;
	};
	days.addEventListener('pointerover', show);
	days.addEventListener('pointerdown', show);
	days.addEventListener('pointerleave', hide);

	// Narrow screens scroll the weeks sideways, starting from today.
	const scroller = el('div', { className: 'weeks' }, months, days);
	scroller.addEventListener('scroll', hide, { passive: true });
	requestAnimationFrame(() => (scroller.scrollLeft = scroller.scrollWidth));
	const since = server.uptime?.from;
	return el('div', { className: 'calendar' },
		el('div', { className: 'weekdays', ariaHidden: 'true' }, ...WEEKDAYS.map(d => el('span', { textContent: d }))),
		scroller,
		since && since > first ? el('p', { className: 'since', textContent: `Tracked since ${dateText(since)}` }) : null);
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
		yearGrid(server, now));
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
