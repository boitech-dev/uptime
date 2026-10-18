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

/** Downtime, exactly: seconds under a minute, minutes and seconds under an hour, hours and minutes beyond. */
function downtime(seconds) {
	const s = Math.round(seconds);
	if (s < 60) return `${s} s`;
	if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
	const minutes = Math.floor(s / 60) % 60;
	return minutes ? `${Math.floor(s / 3600)} h ${minutes} min` : `${Math.floor(s / 3600)} h`;
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
	return [down > 0 ? `Machine down for ${downtime(down)}` : 'Machine running the whole time', `Offline for ${downtime(data.tracked - data.online)}`];
}

/** Shows a day's tooltip over its square (`.day`, with `data-day`) in `container`; returns what hides it. */
function dayTips(container, linesOf) {
	const tip = document.getElementById('tip');
	let shown = null;
	const show = event => {
		const cell = event.target.closest('.day:not(.outside)');
		if (!cell || cell === shown) return;
		shown?.classList.remove('hover');
		shown = cell;
		cell.classList.add('hover');
		const day = Number(cell.dataset.day);
		tip.replaceChildren(el('strong', { textContent: dateText(day, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) }), ...linesOf(day).map(l => el('div', { textContent: l })));
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
	container.addEventListener('pointerover', show);
	container.addEventListener('pointerdown', show);
	container.addEventListener('pointerleave', hide);
	return hide;
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
	const hide = dayTips(days, day => dayLines(byDay.get(day)));

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

/** A share of the time, with the downtime it leaves: over the year, then over 30 days. */
function figure(label, part, whole, monthPart, monthWhole) {
	const lost = whole - part;
	const monthLost = monthWhole - monthPart;
	return el('div', { className: 'figure' },
		el('dt', { textContent: label }),
		el('dd', {},
			el('span', { className: 'year', textContent: showPercent(percent(part, whole)) }),
			el('span', { className: 'total', textContent: lost > 0 ? `Down for ${downtime(lost)}` : 'No downtime' }),
			el('span', { className: 'month' }, `30 days: ${showPercent(percent(monthPart, monthWhole))} `, monthLost > 0 ? el('span', { textContent: `(${downtime(monthLost)})` }) : null)));
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

/** A service now: up when its latest check got through and its server is online; silent past two missed checks. */
function serviceState(service, server, now) {
	if (!service.lastAt) return { key: 'silent', label: 'Waiting for its first check' };
	const age = now - service.lastAt;
	if (age > STALE) return { key: 'silent', label: `No news for ${duration(age)}` };
	if (server && !server.lastOnline) return { key: 'down', label: `Down: ${server.name} is offline` };
	const speed = service.lastMs < 1 ? 'under 1 ms' : service.lastMs < 1000 ? `${service.lastMs} ms` : `${(service.lastMs / 1000).toFixed(1)} s`;
	return service.lastOk ? { key: 'up', label: `Up, answered in ${speed}` } : { key: 'down', label: 'Down' };
}

/** The last 30 days, a square each, shaded like the year grid. */
function monthStrip(service, now) {
	const today = Math.floor(now / DAY) * DAY;
	const byDay = new Map((service.uptime?.days ?? []).map(d => [d.day, d]));
	const strip = el('div', { className: 'strip', role: 'img' });
	let bad = 0;
	for (let day = today - 29 * DAY; day <= today; day += DAY) {
		const cell = el('span', { className: 'day' });
		cell.dataset.day = day;
		const data = byDay.get(day);
		if (!data?.tracked) cell.classList.add('untracked');
		else if (data.tracked - data.up > 0) {
			bad++;
			cell.classList.add('down');
			cell.style.setProperty('--depth', `${depth(data.tracked - data.up)}%`);
		} else cell.classList.add('calm');
		strip.append(cell);
	}
	strip.setAttribute('aria-label', bad ? `Over the last 30 days, ${bad} days with downtime.` : 'No downtime over the last 30 days tracked.');
	dayTips(strip, day => {
		const data = byDay.get(day);
		if (!data?.tracked) return ['Not tracked yet'];
		return data.tracked - data.up > 0 ? [`Down for ${downtime(data.tracked - data.up)}`] : ['Up the whole time'];
	});
	return strip;
}

function serviceCard(service, servers, now) {
	const state = serviceState(service, servers.find(s => s.name === service.server), now);
	const u = service.uptime;
	const lost = u ? u.year.tracked - u.year.up : 0;
	const remove = el('button', { type: 'button', className: 'link-button', textContent: 'Remove' });
	remove.addEventListener('click', async () => {
		if (!confirm(`Remove ${service.name} and its history?`)) return;
		const response = await fetch(`/api/services/${service.id}`, { method: 'DELETE' }).catch(() => null);
		if (!response?.ok) alert(response ? await response.text() : 'The dashboard can’t be reached. Check your connection and try again.');
		load();
	});
	const edit = el('button', { type: 'button', className: 'link-button', textContent: 'Edit' });
	edit.addEventListener('click', () => openEditor(service));
	const handle = handleFor(`Move ${service.name}: drag it, or use the arrow keys`);
	const card = el('article', { className: `card ${state.key}` },
		el('div', { className: 'card-head' }, el('span', { className: 'dot' }), el('h3', { textContent: service.name }), handle),
		el('p', { className: 'address', textContent: service.url, title: service.expect ? `${service.url}, answering “${service.expect}”` : service.url }),
		el('p', { className: 'card-state', textContent: state.label }),
		u ? el('p', { className: 'card-figure', textContent: showPercent(percent(u.year.up, u.year.tracked)) }) : null,
		u ? el('p', { className: 'card-detail', textContent: lost > 0 ? `Down for ${downtime(lost)}` : 'No downtime' }) : null,
		u ? el('p', { className: 'card-detail muted', textContent: `30 days: ${showPercent(percent(u.month.up, u.month.tracked))}` }) : null,
		monthStrip(service, now),
		el('div', { className: 'card-foot' }, el('span', { textContent: `Runs on ${service.server}` }), el('span', { className: 'actions' }, edit, remove)));
	card.dataset.id = service.id;
	handle.addEventListener('pointerdown', event => drag(event, card, '#services .card'));
	handle.addEventListener('keydown', event => nudge(event, card, '#services .card[data-id]', '.card-head .handle'));
	return card;
}

const GRIP = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>';

/** A drag handle: what it moves, and how its arrow keys move it. */
function handleFor(label) {
	const handle = el('button', { type: 'button', className: 'handle', ariaLabel: label });
	handle.innerHTML = GRIP;
	return handle;
}

/**
 * The services under their groups' headings: groups in the order of their first card. Once there are groups, the
 * services without one get a heading too, so that they can move like a group.
 */
function serviceGroups(services, servers, now) {
	const groups = [];
	for (const service of services) {
		const name = service.group ?? '';
		let group = groups.find(g => g.name === name);
		if (!group) groups.push((group = { name, cards: [] }));
		group.cards.push(serviceCard(service, servers, now));
	}
	const named = groups.some(g => g.name);
	return groups.map(g => {
		const title = g.name || 'Without a group';
		const handle = named ? handleFor(`Move the group ${title}: drag it, or use the arrow keys`) : null;
		const section = el('div', { className: 'group' },
			named ? el('div', { className: 'group-head' }, el('h3', { className: `group-title${g.name ? '' : ' muted'}`, textContent: title }), handle) : null,
			el('div', { className: 'cards' }, ...g.cards));
		section.dataset.group = g.name;
		handle?.addEventListener('pointerdown', event => drag(event, section, '#services .group', true));
		handle?.addEventListener('keydown', event => nudge(event, section, '#services .group', '.group-head .handle'));
		return section;
	});
}

// --- arranging -------------------------------------------------------------------------------------------------

/** True while something is dragged or the editor is open: the minute's refresh waits. */
let busy = false;

/** Saves the order on the page (groups, then the cards in each, under their group), then shows it as saved. */
async function saveOrder() {
	const order = [...document.querySelectorAll('#services .group')].flatMap(group =>
		[...group.querySelectorAll('.card[data-id]')].map(card => ({ id: Number(card.dataset.id), group: group.dataset.group })));
	const response = await fetch('/api/services/order', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) }).catch(() => null);
	if (!response?.ok) alert(response ? await response.text() : 'The dashboard can’t be reached: the new order wasn’t saved.');
	await load();
}

/**
 * Drags `item` (a card, or a whole group) by its handle, with a mouse or a finger: it drops before or after the
 * item of the same kind (`selector`) under the pointer, by halves: left and right for cards, top and bottom for groups.
 */
function drag(event, item, selector, vertical = false) {
	if (event.button !== 0) return;
	event.preventDefault();
	busy = true;
	const box = item.getBoundingClientRect();
	const [dx, dy] = [event.clientX - box.left, event.clientY - box.top];
	const placeholder = el('div', { className: `${item.className} placeholder` });
	placeholder.style.height = `${box.height}px`;
	item.before(placeholder);
	item.classList.add('dragging');
	Object.assign(item.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` });
	const move = e => {
		item.style.left = `${e.clientX - dx}px`;
		item.style.top = `${e.clientY - dy}px`;
		const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(`${selector}:not(.placeholder):not(.dragging)`);
		if (target) {
			const t = target.getBoundingClientRect();
			const before = vertical ? e.clientY < t.top + t.height / 2 : e.clientX < t.left + t.width / 2;
			target[before ? 'before' : 'after'](placeholder);
		}
	};
	const drop = () => {
		window.removeEventListener('pointermove', move);
		placeholder.replaceWith(item);
		item.classList.remove('dragging');
		item.removeAttribute('style');
		busy = false;
		saveOrder();
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', drop, { once: true });
	window.addEventListener('pointercancel', drop, { once: true });
}

/** The arrow keys move an item one place earlier or later among those of its kind (cards: across groups too). */
function nudge(event, item, selector, handleSelector) {
	const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
	if (!step) return;
	event.preventDefault();
	const items = [...document.querySelectorAll(selector)];
	const other = items[items.indexOf(item) + step];
	if (!other) return;
	other[step < 0 ? 'before' : 'after'](item);
	const key = item.dataset.id ? `[data-id="${item.dataset.id}"]` : `[data-group="${CSS.escape(item.dataset.group)}"]`;
	saveOrder().then(() => document.querySelector(`${selector}${key} ${handleSelector}`)?.focus());
}

/** The editor: name, address, expected text and group. */
function openEditor(service) {
	const dialog = document.getElementById('service-dialog');
	const form = document.getElementById('edit-form');
	form.dataset.id = service.id;
	form.elements.name.value = service.name;
	form.elements.url.value = service.url;
	form.elements.expect.value = service.expect ?? '';
	form.elements.group.value = service.group ?? '';
	document.getElementById('edit-server').textContent = service.server;
	document.getElementById('edit-error').hidden = true;
	busy = true;
	dialog.showModal();
}

function headline(servers, now) {
	if (!servers.length) return 'No servers yet';
	const online = servers.filter(s => stateOf(s, now).key === 'online').length;
	if (online === servers.length) return servers.length === 1 ? `${servers[0].name} is online` : `All ${servers.length} servers online`;
	return `${online} of ${servers.length} servers online`;
}

async function load() {
	if (busy) return;
	const main = document.getElementById('servers');
	try {
		const response = await fetch('/api/servers', { cache: 'no-store' });
		if (!response.ok) throw new Error(`the dashboard answered ${response.status}`);
		const { now, servers, services } = await response.json();
		document.getElementById('headline').textContent = headline(servers, now);
		document.getElementById('updated').textContent = `Updated at ${timeText(now)}.`;
		main.replaceChildren(...(servers.length
			? servers.map(s => serverSection(s, now))
			: [el('p', { className: 'empty', textContent: 'Add your first server below: you’ll get the one line to run on it.' })]));
		const up = services.filter(s => serviceState(s, servers.find(v => v.name === s.server), now).key === 'up').length;
		document.getElementById('services-summary').textContent = services.length ? `${up} of ${services.length} up` : '';
		document.getElementById('services').replaceChildren(...(services.length
			? serviceGroups(services, servers, now)
			: [el('p', { className: 'empty', textContent: 'No services yet: add one below, on the server it runs on.' })]));
		document.getElementById('groups').replaceChildren(...[...new Set(services.map(s => s.group).filter(Boolean))].map(g => el('option', { value: g })));
		// The servers a service can run on, keeping the choice in progress.
		const select = document.getElementById('service-server');
		const chosen = select.value;
		select.replaceChildren(...servers.map(s => el('option', { value: s.name, textContent: s.name })));
		if (servers.some(s => s.name === chosen)) select.value = chosen;
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
// Adding a service: the server it runs on checks it from its next minute.
document.getElementById('service-form').addEventListener('submit', async event => {
	event.preventDefault();
	const form = event.target;
	const error = document.getElementById('service-error');
	error.hidden = true;
	const body = { name: form.elements.name.value, url: form.elements.url.value, expect: form.elements.expect.value, group: form.elements.group.value, server: form.elements.server.value };
	const response = await fetch('/api/services', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
	if (!response?.ok) {
		error.textContent = response ? await response.text() : 'The dashboard can’t be reached. Check your connection and try again.';
		error.hidden = false;
		return;
	}
	for (const field of ['name', 'url', 'expect']) form.elements[field].value = '';
	load();
});
document.getElementById('edit-form').addEventListener('submit', async event => {
	event.preventDefault();
	const form = event.target;
	const error = document.getElementById('edit-error');
	const body = { name: form.elements.name.value, url: form.elements.url.value, expect: form.elements.expect.value, group: form.elements.group.value };
	const response = await fetch(`/api/services/${form.dataset.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
	if (!response?.ok) {
		error.textContent = response ? await response.text() : 'The dashboard can’t be reached. Check your connection and try again.';
		error.hidden = false;
		return;
	}
	document.getElementById('service-dialog').close();
});
document.getElementById('edit-cancel').addEventListener('click', () => document.getElementById('service-dialog').close());
document.getElementById('service-dialog').addEventListener('close', () => {
	busy = false;
	load();
});
document.getElementById('add-copy').addEventListener('click', async event => {
	await navigator.clipboard.writeText(document.getElementById('add-command').textContent);
	event.target.textContent = 'Copied';
	setTimeout(() => (event.target.textContent = 'Copy command'), 2000);
});

load();
setInterval(load, 60_000);
