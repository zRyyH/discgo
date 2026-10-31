# Production runbook (PLAN 9, fase 10)

One VM on Magalu Cloud runs everything with Docker Compose: nginx + certbot (TLS),
LiveKit (SFU + TURN), the production API with its PostgreSQL and nightly backup, and a
second, development API with its own PostgreSQL. Attachments and backups live in one
private AWS S3 bucket; the desktop releases are files on the VM, served by nginx.

```
api.DOMAIN      ─443─► nginx ─► api      127.0.0.1:8080  (REST + /v1/gateway)
                               /releases/ → /opt/discgo-releases
api-dev.DOMAIN  ─443─► nginx ─► api-dev  127.0.0.1:8081
                               /releases/ → /opt/discgo-releases/dev
lk.DOMAIN       ─443─► nginx ─► livekit  127.0.0.1:7880  (signalling)
                     livekit 7881/tcp, 7882/udp (media) · TURN/STUN 3478/udp, 5349/tcp
```

| | |
|---|---|
| `DOMAIN` | `discgo.awpsoft.com.br` (`A` records `api`, `lk`, `turn`, `api-dev` → the VM) |
| VM | `201.23.67.225`, Ubuntu 24.04, 4 vCPU / 8 GB / 40 GB, user `ubuntu` (`ssh magalu`) |
| Production | `/opt/discgo` (branch `main`), compose project `discgo` |
| Development | `/opt/discgo-dev` (branch `develop`), compose project `discgo-dev` |
| Releases | `/opt/discgo-releases` (production) and `/opt/discgo-releases/dev` (DiscGo Dev) |
| S3 | bucket `discgo` (us-east-1, private): `att/` attachments, `db/` backups |

## 1. Branches, CI and releases

- `main` is production, `develop` is development. Work happens on `feat/…`, `fix/…`,
  `chore/…`, `docs/…` or `hotfix/…` branches (rulesets reject other names) and goes to
  `develop` in a PR, **squash** merged: the PR title becomes the commit, so it must be in
  Conventional Commits (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `ci:`, `chore:`).
- `develop` → `main` is a PR with a **merge commit** (release-please reads the commits).
- Every PR and every push to `develop`/`main` runs [ci.yml](../.github/workflows/ci.yml);
  its final `ci` job is required by the rulesets (no force push or deletion of either
  branch; `main` only through PRs).
- A push to `develop` ([deploy.yml](../.github/workflows/deploy.yml)) deploys the
  development API and publishes a new DiscGo Dev installer. A push to `main` deploys
  production and updates the release PR
  ([release-please.yml](../.github/workflows/release-please.yml)).
- Merging the release PR (version in `tauri.conf.json`, `package.json`, `Cargo.toml`,
  `CHANGELOG.md`) tags `vX.Y.Z` and runs [release.yml](../.github/workflows/release.yml):
  the installer, its `.sig`, `DiscGo-Setup.exe` and, last, `latest.json` go to
  `/opt/discgo-releases`. The API sees the new `latest.json` within a minute and every
  app updates itself (PLAN fase 9A). The deploy of `main` always comes before the tag, so
  the API is ready for the new app first.
- `feat` makes a minor release, `fix`/`perf` a patch; `chore`, `docs`, `ci`, `refactor`
  (and Dependabot's `chore(deps)`) make none. After a release or a hotfix, bring `main`
  back into `develop` with a PR `main → develop` (merge commit), so `develop` has the new
  version and changelog.
- Dependabot opens grouped minor/patch updates against `develop` every Monday.

GitHub configuration (done once, 2026-10-30): squash and merge commits allowed, rebase
off, branches deleted after merge; Actions may create PRs; environments `production`
(branch `main`, tags `v*`) and `development` (branch `develop`), each with the variable
`VITE_API_URL`; repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the updater key, no
password), `VM_HOST`, `VM_USER`, `VM_SSH_KEY` (a key only for CI) and `VM_KNOWN_HOSTS`
(`ssh-keyscan -H 201.23.67.225`).

## 2. The VM (done once)

Ubuntu updated, 2 GB swap, time zone `America/Sao_Paulo`, unattended security upgrades,
`fail2ban` for SSH, Docker Engine + compose plugin from Docker's repository, `ubuntu` in
the `docker` group. `/etc/docker/daemon.json` gives compose networks `10.210.0.0/16`
(the VM's own subnet is `172.18.0.0/20`, which Docker would otherwise reuse) and caps
container logs at 5 × 10 MB. `/etc/sysctl.d/90-livekit.conf` raises the UDP buffers.

Firewall: the Magalu security group and `ufw` open the same ports.

| Port | Protocol | Why |
|---|---|---|
| 22 | tcp | SSH (`ufw limit`: at most 6 new connections in 30 s per address) |
| 80 | tcp | Let's Encrypt HTTP-01 + redirect |
| 443 | tcp | APIs, gateway, LiveKit signalling, releases |
| 7881 | tcp | LiveKit media over TCP |
| 7882 | udp | LiveKit media (single UDP port) |
| 3478 | udp | TURN/STUN |
| 5349 | tcp | TURN over TLS |

The VM cannot reach its own public IP (no hairpin NAT), so the API containers resolve
`api.DOMAIN` / `api-dev.DOMAIN` to the host (`extra_hosts: host-gateway`) to read their
`latest.json`.

Checkouts are clones over HTTPS (the repository is public). CI logs in with its own key
(`restrict` in `~/.ssh/authorized_keys`). If the repository becomes private, register
the read-only key already on the VM and switch the remotes to SSH:
`gh repo deploy-key add <(ssh magalu cat .ssh/discgo_deploy.pub) --title magalu-vm`, then
`git -C /opt/discgo remote set-url origin git@github.com:zRyyH/discgo.git` (and the same
for `/opt/discgo-dev`), with `IdentityFile ~/.ssh/discgo_deploy` for `github.com` in the
VM's `~/.ssh/config`.

Weekly cron (`crontab -l` of `ubuntu`): LiveKit reads the TURN certificate only at start,
so it restarts on Mondays at 04:00.

## 3. Configuration

Not in git (`deploy/.env*` and `livekit.yaml` are ignored); generated secrets were made
on the VM with `openssl rand -hex`.

**`/opt/discgo/deploy/.env`** (production; start from `deploy/.env.example`): `DOMAIN`,
`LETSENCRYPT_EMAIL`, `POSTGRES_PASSWORD`, `PUBLIC_URL=https://api.DOMAIN`, the Google
client (`GOOGLE_CLIENT_ID`/`SECRET`), `AUTH_REDIRECT=discgo://auth`, `AUTH_DEV=false`,
`LIVEKIT_URL=wss://lk.DOMAIN`, `LIVEKIT_API_KEY`/`SECRET` (the first pair in
`livekit.yaml`), `STUN_URLS=stun:turn.DOMAIN:3478`, `S3_REGION=us-east-1`,
`S3_BUCKET=discgo`, `S3_ENDPOINT=` (empty), `S3_CREATE_BUCKET=false`, `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY`, `BACKUP_S3_URI=s3://discgo/db`,
`RELEASES_URL=https://api.DOMAIN/releases/latest.json`, `COMMUNITY_NAME`.

**`/opt/discgo-dev/deploy/.env`** (development): the same, except
`PUBLIC_URL=https://api-dev.DOMAIN`, `AUTH_REDIRECT=discgo-dev://auth`, the second
LiveKit key pair, its own `POSTGRES_PASSWORD`, no `BACKUP_*`,
`RELEASES_URL=https://api-dev.DOMAIN/releases/latest.json` and
`COMMUNITY_NAME="DiscGo Dev"` (quoted: `deploy.sh` sources the file). Attachments share
the bucket; their keys carry the user id, which differs between the two databases.

**`/opt/discgo/deploy/livekit/livekit.yaml`** (from `livekit.yaml.example`): the domain and
both key pairs. One LiveKit and one TURN serve both environments; rooms are channel
UUIDs, so they never collide. Only production gets the webhook. After editing it:
`docker compose -f docker-compose.prod.yml restart livekit`.

**S3** (bucket `discgo`): CORS for the app's origin (uploads go straight from the app):

```json
{"CORSRules": [{"AllowedOrigins": ["http://tauri.localhost", "https://tauri.localhost"],
  "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 3000}]}
```

and a lifecycle rule that expires `db/` after 30 days. Both were applied from the VM with
the backup container's AWS CLI, e.g.
`docker compose -f docker-compose.prod.yml exec -T backup aws s3api get-bucket-cors --bucket discgo`.
The IAM user needs at least `s3:PutObject`/`s3:GetObject` on `discgo/att/*` and
`s3:PutObject` on `discgo/db/*`.

**Google OAuth** (Google Cloud Console → APIs & Services → Credentials, the *Web
application* client in `GOOGLE_CLIENT_ID`). Authorized redirect URIs:
`https://api.DOMAIN/v1/auth/google/callback`, `https://api-dev.DOMAIN/v1/auth/google/callback`
and, for local development, `http://localhost:8080/v1/auth/google/callback`. While the
app is in testing, every friend must be in "Test users" (or publish the app: Audience →
Publish; these scopes need no review). Quick check without a browser: a valid redirect
URI sends `https://api.DOMAIN/v1/auth/google/start` on to Google's sign-in page, a
missing one to `accounts.google.com/signin/oauth/error`.

## 4. Deploy and operate

CI deploys on every push. By hand, on the VM:

```bash
cd /opt/discgo && git fetch --prune origin && git checkout --force origin/main && deploy/scripts/deploy.sh
cd /opt/discgo-dev && git fetch --prune origin && git checkout --force origin/develop && deploy/scripts/deploy.sh dev
/opt/discgo/deploy/scripts/deploy.sh backup     # one backup now (s3://discgo/db/)
```

The first production run issues the certificate for `api`, `lk`, `turn` and `api-dev`
(standalone on port 80); certbot renews it and nginx reloads every 6 h. A change in
`nginx/templates` recreates nginx (`NGINX_CONF_HASH`), which drops open gateway
connections for a second; the apps reconnect. Migrations run when the API starts.

Logs: `docker compose -f docker-compose.prod.yml logs -f api` (or `nginx`, `livekit`) in
`/opt/discgo/deploy`; `docker compose -f docker-compose.dev-env.yml logs -f api` in
`/opt/discgo-dev/deploy`.

Restore: `aws s3 cp s3://discgo/db/<file>.sql.gz - | gunzip | docker compose -f docker-compose.prod.yml exec -T postgres psql -U discgo discgo`
(the backup container has the AWS CLI and the keys).

Rotating the AWS key: create the new key in IAM, replace `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY` in both `.env` files, run both deploys (or
`docker compose … up -d` in each), check a backup and an upload, delete the old key.

## 5. Acceptance checks (phase 7, on real infrastructure)

1. `curl https://api.DOMAIN/healthz` and `https://api-dev.DOMAIN/healthz` → `{"status":"ok"}`.
2. Two people on different home networks in one voice channel: the debug overlay
   (Ctrl+Shift+D) shows `modo p2p` and a `srflx` candidate pair.
3. Three people: `modo sfu`, audio and video between all of them.
4. TURN forced: in a client, block UDP 7882 and TCP 7881 outbound (Windows firewall) and
   join with three people; LiveKit falls back to TURN (`relay` candidates).
5. A backup file in `s3://discgo/db/` after `deploy.sh backup` (and every night).
6. A real forced update: a `fix:` merged to `main`, its release PR merged, every app on
   the new version within 90 s of `latest.json` changing.
