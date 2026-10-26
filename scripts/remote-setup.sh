#!/bin/bash
set -euo pipefail

DOMAIN="${SYNC_DOMAIN:?Set SYNC_DOMAIN}"
APP_DIR="/opt/e2ee-sync"
DATA_DIR="/var/lib/e2ee-sync"
PORT="${SYNC_PORT:-8791}"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "== install node 22 =="
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi
node -v

mkdir -p "$APP_DIR" "$DATA_DIR"
if [ -f /etc/e2ee-sync.env ]; then
  chmod 600 /etc/e2ee-sync.env
fi
tar -xzf /tmp/e2ee-sync-server.tgz -C "$APP_DIR"
cat > "$APP_DIR/package.json" <<'EOF'
{ "type": "module", "private": true }
EOF

cat > /etc/systemd/system/e2ee-sync.service <<EOF
[Unit]
Description=Obsidian e2ee sync server
After=network.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=-/etc/e2ee-sync.env
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=SERVER_MODE=central
Environment=REQUIRE_ENCRYPTION=false
ExecStart=$(command -v node) dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable e2ee-sync
systemctl restart e2ee-sync
systemctl is-active e2ee-sync
ready=0
for _ in $(seq 1 48); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/v1/health"; then
    ready=1
    echo
    break
  fi
  sleep 5
done
if [ "$ready" != 1 ]; then
  systemctl status e2ee-sync --no-pager || true
  journalctl -u e2ee-sync -n 60 --no-pager || true
  exit 1
fi

SITE="/etc/nginx/sites-available/${DOMAIN}"
cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sfn "$SITE" "/etc/nginx/sites-enabled/${DOMAIN}"
nginx -t
systemctl reload nginx

if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --key-type ecdsa; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --key-type ecdsa
fi

nginx -t
systemctl reload nginx
echo "== https =="
curl -fsS "https://${DOMAIN}/api/v1/health"
echo
echo "== renewal =="
sed -n '1,30p' "/etc/letsencrypt/renewal/${DOMAIN}.conf"
