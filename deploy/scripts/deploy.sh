#!/usr/bin/env bash
# Deploys (or updates) DiscGo on the VM (PLAN fase 10). Run from anywhere inside a checkout:
#   deploy/scripts/deploy.sh            production (/opt/discgo): certificate, build, restart
#   deploy/scripts/deploy.sh dev        development API (/opt/discgo-dev, api-dev.DOMAIN)
#   deploy/scripts/deploy.sh backup     one production database backup now
# The first production run also issues the Let's Encrypt certificate (standalone, port 80).
# CI runs it after every push to main or develop (.github/workflows/deploy.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "deploy/.env missing (copy .env.example)"; exit 1; }
set -a; . ./.env; set +a
: "${DOMAIN:?}"

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "$1/healthz" >/dev/null; then
      echo "healthy: $1/healthz"
      return 0
    fi
    sleep 2
  done
  echo "API did not become healthy at $1/healthz; check: docker compose -f deploy/$2 logs api" >&2
  return 1
}

if [ "${1:-}" = dev ]; then
  # nginx and LiveKit belong to the production checkout; this is only the API and its database.
  docker compose -f docker-compose.dev-env.yml --env-file .env up -d --build --remove-orphans
  docker compose -f docker-compose.dev-env.yml --env-file .env ps
  healthy "https://api-dev.$DOMAIN" docker-compose.dev-env.yml
  exit
fi

[ -f livekit/livekit.yaml ] || { echo "deploy/livekit/livekit.yaml missing (copy livekit.yaml.example)"; exit 1; }
: "${LETSENCRYPT_EMAIL:?}"
compose() { docker compose -f docker-compose.prod.yml --env-file .env "$@"; }

if [ "${1:-}" = backup ]; then
  compose exec backup /usr/local/bin/backup.sh now
  exit 0
fi

# One certificate for every name; --expand adds a name missing from an older one.
domains=()
for n in api lk turn api-dev; do domains+=(-d "$n.$DOMAIN"); done
certs=$(compose run --rm --entrypoint certbot certbot certificates --cert-name "api.$DOMAIN" 2>/dev/null || true)
if ! grep -q "Domains:.* api-dev\.$DOMAIN" <<<"$certs"; then
  echo "issuing certificate: ${domains[*]}"
  compose stop nginx 2>/dev/null || true
  compose run --rm -p 80:80 --entrypoint certbot certbot certonly --standalone --non-interactive --agree-tos \
    --email "$LETSENCRYPT_EMAIL" --cert-name "api.$DOMAIN" --expand "${domains[@]}"
fi

# nginx renders its templates only when the container starts: a change in them changes
# this hash, and compose recreates nginx.
NGINX_CONF_HASH=$(cat nginx/templates/* | sha256sum | cut -c1-16)
export NGINX_CONF_HASH

compose build --pull api backup
compose up -d --remove-orphans
compose ps
healthy "https://api.$DOMAIN" docker-compose.prod.yml
