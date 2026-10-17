#!/bin/sh
# Installs the Uptime dashboard on a Linux server with systemd, in one line, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/boitech-dev/uptime/main/install.sh | sudo UPTIME_URL=https://uptime.example.com sh
#
# UPTIME_URL is the address the dashboard will have: put an HTTPS proxy for it in front of 127.0.0.1:3480.
# Optional: UPTIME_PORT (3480), UPTIME_USER (the login, "uptime"), UPTIME_REF (the branch or tag, "main").
# Running it again updates the dashboard and keeps its data, settings and login.
#
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
# What it installs must be readable by the services' own users, whatever the caller's umask.
umask 022

REPO=https://github.com/boitech-dev/uptime
REF=${UPTIME_REF:-main}
PORT=${UPTIME_PORT:-3480}
LOGIN=${UPTIME_USER:-uptime}
DIR=/opt/uptime
ENV=/etc/uptime/env

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
for tool in curl tar xz sha256sum systemctl runuser; do
	command -v "$tool" >/dev/null || die "$tool is required"
done
[ -f "$ENV" ] || [ -n "${UPTIME_URL:-}" ] || die "set UPTIME_URL, the dashboard's public address (https://…)"
case "$(uname -m)" in
	x86_64 | amd64) ARCH=x64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "unsupported architecture $(uname -m)" ;;
esac

id uptime >/dev/null 2>&1 || useradd --system --home-dir /var/lib/uptime --shell /usr/sbin/nologin uptime
install -d -m 0755 "$DIR"
install -d -m 0750 -o uptime -g uptime /var/lib/uptime
install -d -m 0750 -o root -g uptime /etc/uptime
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Node.js 24, its own copy, checked against nodejs.org's checksums.
if ! "$DIR/node/bin/node" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null; then
	say "Downloading Node.js 24"
	curl -fsSL -o "$TMP/SHASUMS256.txt" https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
	FILE=$(awk -v f="linux-$ARCH.tar.xz" '$2 ~ f"$" { print $2 }' "$TMP/SHASUMS256.txt")
	[ -n "$FILE" ] || die "no Node.js 24 build for linux-$ARCH"
	curl -fsSL -o "$TMP/$FILE" "https://nodejs.org/dist/latest-v24.x/$FILE"
	(cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node.js download doesn't match its checksum"
	mkdir "$TMP/node"
	tar -xJf "$TMP/$FILE" -C "$TMP/node" --strip-components 1
	rm -rf "$DIR/node"
	mv "$TMP/node" "$DIR/node"
fi
NODE="$DIR/node/bin/node --disable-warning=ExperimentalWarning"

say "Downloading Uptime ($REF)"
mkdir "$TMP/app"
curl -fsSL "$REPO/archive/$REF.tar.gz" | tar -xz -C "$TMP/app" --strip-components 1
rm -rf "$DIR/app.old"
[ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.old"
mv "$TMP/app" "$DIR/app"
rm -rf "$DIR/app.old"

cat >/usr/local/bin/uptimectl <<EOF
#!/bin/sh
# Manages the Uptime dashboard's servers (uptimectl help). Installed by Uptime's install.sh.
set -a
. $ENV
set +a
exec runuser -u uptime -- $NODE $DIR/app/server/src/cli.ts "\$@"
EOF
chmod 0755 /usr/local/bin/uptimectl

if [ ! -f "$ENV" ]; then
	say "Creating the login"
	PASSWORD=$(head -c 18 /dev/urandom | base64 | tr '+/' '-_')
	HASH=$(printf '%s\n' "$PASSWORD" | $NODE "$DIR/app/server/src/cli.ts" password)
	(umask 027 && cat >"$ENV" <<EOF
UPTIME_URL=$UPTIME_URL
UPTIME_PORT=$PORT
UPTIME_DB=/var/lib/uptime/uptime.db
UPTIME_USER=$LOGIN
UPTIME_PASSWORD_HASH=$HASH
EOF
	)
	chgrp uptime "$ENV"
	# Shown now, the moment it exists, so that nothing failing further on can lose it.
	echo "The dashboard's login, shown only this once (save it in your password manager):"
	echo "  user: $LOGIN"
	echo "  password: $PASSWORD"
fi

cat >/etc/systemd/system/uptime.service <<EOF
[Unit]
Description=Uptime dashboard
After=network.target

[Service]
User=uptime
Group=uptime
EnvironmentFile=$ENV
ExecStart=$NODE $DIR/app/server/src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
ReadWritePaths=/var/lib/uptime

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable uptime.service >/dev/null
systemctl restart uptime.service

. "$ENV"
for _ in 1 2 3 4 5 6 7 8 9 10; do
	curl -fs "http://127.0.0.1:$UPTIME_PORT/health" >/dev/null && break
	sleep 1
done
curl -fs "http://127.0.0.1:$UPTIME_PORT/health" >/dev/null || die "the dashboard didn't start: journalctl -u uptime"

say "Uptime runs on 127.0.0.1:$UPTIME_PORT"
echo "Serve $UPTIME_URL from it through an HTTPS proxy that keeps the Host header, e.g. with Caddy:"
echo "  ${UPTIME_URL#https://} { reverse_proxy 127.0.0.1:$UPTIME_PORT }"
echo
echo "Then add your servers on the dashboard: it gives each one its install command."
