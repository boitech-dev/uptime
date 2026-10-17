#!/bin/sh
# Installs the Uptime agent on a Linux server with systemd: its own system user, the agent, its settings, and a
# timer that runs it every minute. Run as root, with the URL and token `uptimectl add <name>` printed:
#
#   curl -fsSL https://uptime.example.com/agent/install.sh | sudo UPTIME_URL=https://uptime.example.com UPTIME_TOKEN=upt_… sh
#
# Running it again updates the agent and its settings. To remove it:
#   systemctl disable --now uptime-agent.timer; rm /etc/systemd/system/uptime-agent.* /usr/local/bin/uptime-agent /etc/uptime-agent.conf
#
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
: "${UPTIME_URL:?UPTIME_URL is missing}"
: "${UPTIME_TOKEN:?UPTIME_TOKEN is missing}"
for tool in curl ping awk systemctl; do
	command -v "$tool" >/dev/null || die "$tool is required"
done

id uptime-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin uptime-agent

curl -fsSL -o /usr/local/bin/uptime-agent.new "$UPTIME_URL/agent/uptime-agent" || die "couldn't download the agent from $UPTIME_URL"
chmod 0755 /usr/local/bin/uptime-agent.new
mv /usr/local/bin/uptime-agent.new /usr/local/bin/uptime-agent

# The token: readable by root and the agent only.
(umask 077 && printf 'UPTIME_URL=%s\nUPTIME_TOKEN=%s\n' "$UPTIME_URL" "$UPTIME_TOKEN" >/etc/uptime-agent.conf)
chown root:uptime-agent /etc/uptime-agent.conf
chmod 0640 /etc/uptime-agent.conf

cat >/etc/systemd/system/uptime-agent.service <<'EOF'
[Unit]
Description=Uptime agent: is this machine running and online?
# Not network-online.target: being offline is what it records too.
After=network.target

[Service]
Type=oneshot
User=uptime-agent
ExecStart=/usr/local/bin/uptime-agent
StateDirectory=uptime-agent
TimeoutStartSec=50
# ping gets CAP_NET_RAW from its file capability (or set-user-ID bit): that needs it in the bounding set,
# and rules out NoNewPrivileges and the options that imply it. Nothing else is allowed.
CapabilityBoundingSet=CAP_NET_RAW
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
EOF

cat >/etc/systemd/system/uptime-agent.timer <<'EOF'
[Unit]
Description=Run the Uptime agent every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now uptime-agent.timer >/dev/null
systemctl start uptime-agent.service
echo "Uptime agent installed: it reports every minute (journalctl -u uptime-agent)."
