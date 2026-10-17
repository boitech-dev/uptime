// SPDX-License-Identifier: AGPL-3.0-only
/**
 * uptimectl: manages the dashboard's servers and login. Uses the same settings as the dashboard (UPTIME_DB), plus
 * UPTIME_URL, the dashboard's public address, for the install command.
 */
import { createInterface } from 'node:readline/promises';
import { hashPassword, installCommand } from './http.ts';
import { openStore } from './store.ts';

const USAGE = `usage: uptimectl <command>
  add <name>            add a server: prints the command that installs its agent
  token <name>          give a server a new token (the old one stops working): prints the install command again
  rename <name> <new>   rename a server
  remove <name>         remove a server and its history
  list                  every server and its latest sample
  password              hash a password for UPTIME_PASSWORD_HASH (reads it from stdin)`;

const install = (token: string) => installCommand(process.env.UPTIME_URL ?? 'https://uptime.example.com', token);
const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const [command, ...args] = process.argv.slice(2);
if (command === 'password') {
	const rl = createInterface({ input: process.stdin });
	const password = (await rl[Symbol.asyncIterator]().next()).value as string | undefined;
	rl.close();
	if (!password || password.length < 12) fail('Give a password of at least 12 characters on stdin.');
	console.log(hashPassword(password!));
} else {
	const store = openStore(process.env.UPTIME_DB ?? 'uptime.db');
	const [name, to] = args;
	if (command === 'add' && name) {
		try {
			console.log(`Added ${name}. Install its agent, as root on that server:\n\n${install(store.addServer(name))}`);
		} catch {
			fail(`There's already a server called ${name}.`);
		}
	} else if (command === 'token' && name) {
		const token = store.newToken(name) ?? fail(`No server called ${name}.`);
		console.log(`New token for ${name}. Install its agent again with it:\n\n${install(token)}`);
	} else if (command === 'rename' && name && to) {
		if (!store.rename(name, to)) fail(`No server called ${name}.`);
	} else if (command === 'remove' && name) {
		if (!store.remove(name)) fail(`No server called ${name}.`);
	} else if (command === 'list') {
		for (const s of store.servers()) {
			const latest = s.last_at ? `${new Date(s.last_at * 1000).toISOString()} ${s.last_online ? 'online' : 'offline'}` : 'no sample yet';
			console.log(`${s.name}\t${latest}`);
		}
	} else fail(USAGE);
}
