// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Uptime dashboard. Settings come from the environment:
 *   UPTIME_DB             the SQLite database (default ./uptime.db)
 *   UPTIME_HOST, UPTIME_PORT   where to listen (default 127.0.0.1:3480; put a TLS proxy in front)
 *   UPTIME_USER, UPTIME_PASSWORD_HASH   the dashboard's login (hash from `uptimectl password`)
 *   UPTIME_OPEN=1         no login at all (a public status page)
 *   UPTIME_URL            the dashboard's public address, for the agents' install commands
 */
import { createApp } from './http.ts';
import { openStore } from './store.ts';

const store = openStore(process.env.UPTIME_DB ?? 'uptime.db');
const app = createApp({ store, user: process.env.UPTIME_USER, passwordHash: process.env.UPTIME_PASSWORD_HASH, open: process.env.UPTIME_OPEN === '1', url: process.env.UPTIME_URL });

store.prune();
setInterval(() => store.prune(), 3_600_000);

const host = process.env.UPTIME_HOST ?? '127.0.0.1';
const port = Number(process.env.UPTIME_PORT ?? 3480);
app.listen(port, host, () => console.log(`Uptime dashboard on http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close(() => process.exit(0)));
