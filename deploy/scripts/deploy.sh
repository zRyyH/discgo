#!/usr/bin/env bash
# Deploys (or updates) DiscGo on the VM. Run from anywhere inside the checkout:
#   deploy/scripts/deploy.sh            build, migrate (on API start) and restart
#   deploy/scripts/deploy.sh backup     run one database backup now
# The first run also issues the Let's Encrypt certificate (standalone, port 80).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "deploy/.env missing (copy .env.example)"; exit 1; }
[ -f livekit/livekit.yaml ] || { echo "deploy/livekit/livekit.yaml missing (copy livekit.yaml.example)"; exit 1; }
set -a; . ./.env; set +a
: "${DOMAIN:?}" "${LETSENCRYPT_EMAIL:?}"
compose() { docker compose -f docker-compose.prod.yml --env-file .env "$@"; }

if [ "${1:-}" = backup ]; then
  compose exec backup /usr/local/bin/backup.sh now
  exit 0
fi

if ! compose run --rm --entrypoint test certbot -f "/etc/letsencrypt/live/api.$DOMAIN/fullchain.pem"; then
  echo "issuing certificate for api/lk/turn.$DOMAIN"
  compose stop nginx 2>/dev/null || true
  compose run --rm -p 80:80 --entrypoint certbot certbot certonly --standalone --non-interactive --agree-tos \
    --email "$LETSENCRYPT_EMAIL" -d "api.$DOMAIN" -d "lk.$DOMAIN" -d "turn.$DOMAIN"
fi

compose build --pull api backup
compose up -d --remove-orphans
compose ps

for i in $(seq 1 30); do
  if curl -fsS "https://api.$DOMAIN/healthz" >/dev/null; then
    echo "healthy: https://api.$DOMAIN/healthz"
    exit 0
  fi
  sleep 2
done
echo "API did not become healthy; check: docker compose -f deploy/docker-compose.prod.yml logs api" >&2
exit 1
