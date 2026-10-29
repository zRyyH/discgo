# Production runbook (PLAN 9, phase 7)

One VM on Magalu Cloud (BR-SE1, Ubuntu 24.04) runs everything with Docker Compose:
nginx + certbot (TLS), LiveKit (SFU + TURN), the API, PostgreSQL and a nightly backup.
Attachments, backups and releases live in AWS S3 (sa-east-1).

```
api.DOMAIN  ─443─► nginx ─► api :8080 (REST + /v1/gateway)
lk.DOMAIN   ─443─► nginx ─► livekit :7880 (signalling)
                     livekit 7881/tcp, 7882/udp (media) · TURN 3478/udp, 5349/tcp
```

## 1. Cloud resources

**VM**: 2 vCPU / 4 GB is enough to start (the SFU is the only heavy part; P2P calls do
not touch the VM). Install Docker Engine + the compose plugin, clone the repository
to `/opt/discgo`.

**Security group (inbound)**

| Port | Protocol | Source | Why |
|---|---|---|---|
| 22 | tcp | your IPs only | SSH |
| 80 | tcp | any | Let's Encrypt HTTP-01 + redirect |
| 443 | tcp | any | API, gateway, LiveKit signalling |
| 7881 | tcp | any | LiveKit media over TCP |
| 7882 | udp | any | LiveKit media (single UDP port) |
| 3478 | udp | any | TURN/STUN |
| 5349 | tcp | any | TURN over TLS |

**DNS**: `A` records `api.DOMAIN`, `lk.DOMAIN`, `turn.DOMAIN` → the VM's public IP.

**S3**

- `discgo-attachments` (private). CORS:
  ```json
  [{"AllowedOrigins": ["http://tauri.localhost", "https://tauri.localhost"],
    "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 3000}]
  ```
- `discgo-backups` (private). Lifecycle rule: expire `db/` after 30 days.
- `discgo-releases` (public read on `releases/*`): installers and `latest.json` for the updater (phase 8).

**IAM** user for the VM (keys go to `deploy/.env`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::discgo-attachments/att/*"},
    {"Effect": "Allow", "Action": ["s3:PutObject"], "Resource": "arn:aws:s3:::discgo-backups/db/*"}
  ]
}
```

A separate IAM user for CI publishes releases (`s3:PutObject` on `discgo-releases/releases/*`).

**Google OAuth** (Google Cloud Console → APIs & Services → Credentials → OAuth client ID,
type *Web application*). Authorized redirect URIs:
`https://api.DOMAIN/v1/auth/google/callback` and, for development,
`http://localhost:8080/v1/auth/google/callback`. Put the client ID/secret in `deploy/.env`.

## 2. Configuration

```bash
cd /opt/discgo/deploy
cp .env.example .env                       # then edit: see the production section at the end
cp livekit/livekit.yaml.example livekit/livekit.yaml   # DOMAIN, key and secret
```

In `.env` for production: `PUBLIC_URL=https://api.DOMAIN`, `LIVEKIT_URL=wss://lk.DOMAIN`,
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` equal to `livekit.yaml`, `STUN_URLS=stun:turn.DOMAIN:3478`,
`S3_ENDPOINT=` (empty), `S3_CREATE_BUCKET=false`, `AUTH_DEV=false`, a strong `POSTGRES_PASSWORD`,
the Google client and the IAM keys. Generate secrets with `openssl rand -base64 36`.

## 3. Deploy and update

```bash
deploy/scripts/deploy.sh          # first run issues the certificate, then builds and starts everything
deploy/scripts/deploy.sh backup   # one backup now (check it appears in S3)
```

Updates: `git pull && deploy/scripts/deploy.sh`. Migrations run when the API starts.
LiveKit reads the TURN certificate at start: restart it after renewals, e.g. a weekly cron
`0 4 * * 1 cd /opt/discgo/deploy && docker compose -f docker-compose.prod.yml restart livekit`.

Restore: `aws s3 cp s3://discgo-backups/db/<file>.sql.gz - | gunzip | docker compose -f docker-compose.prod.yml exec -T postgres psql -U discgo discgo`.

## 4. Acceptance checks (phase 7)

1. `curl https://api.DOMAIN/healthz` → `{"status":"ok"}`.
2. Two people on different home networks in one voice channel: the debug overlay
   (Ctrl+Shift+D) shows `modo p2p` and a `srflx` candidate pair.
3. Three people: `modo sfu`, audio and video between all of them.
4. TURN forced: in a client, block UDP 7882 outbound (Windows firewall) and join with three
   people; LiveKit falls back to TURN (`relay` candidates) or TCP 7881.
5. A backup file in `s3://discgo-backups/db/` after `deploy.sh backup` (and every night).
