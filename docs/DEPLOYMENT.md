# Hosting, DNS, backup and recovery

## 1. What the host must actually support

Verify these before committing, as required by specification section 4:

| Requirement | Why |
| --- | --- |
| Long-lived Node process | the in-process scheduler (`src/instrumentation.ts`) |
| Persistent PostgreSQL | prospects, suppressions, jobs, reports |
| Scheduled work | either the in-process ticker or an external cron hitting `/api/cron` |
| HTTPS + stable public hostname | Gmail OAuth callback, Telegram webhook, Pub/Sub push |
| Inbound webhooks | Telegram callbacks, Gmail push |

### Honest limitation

**Cloudflare Pages / Workers cannot host this application.** Workers have no persistent
process, no long-running scheduler and no PostgreSQL. Cloudflare is appropriate for
**DNS only** here.

**There is no genuinely free host that satisfies all five rows above.** Free tiers that
sleep idle containers will stall the scheduler and miss the 24-hour report. Options,
stated plainly:

| Option | Cost | Verdict |
| --- | --- | --- |
| Small VPS (Hetzner CX22 / DigitalOcean 1 GB) + managed or local Postgres | ~$5–7/mo | **Recommended.** Full control, scheduler works. |
| Railway / Render / Fly.io paid instance + managed Postgres | ~$7–20/mo | Works. Keep the instance always-on. |
| Any free tier with container sleep | $0 | **Not viable** for unattended operation. If you must, set `SCHEDULER_ENABLED=0` and drive `/api/cron` from an external uptime cron — the report and reply latency then depend entirely on that external service. |

This is a real deployment prerequisite, not an optional nicety. See
`docs/ACTIVATION.md`.

## 2. DNS (Cloudflare)

```
A    outreach.aurumbespoke.com → <server IP>   (proxy: OFF for the first TLS issuance)
```

Keep the marketing site `aurumbespoke.com` untouched. Use a subdomain for the console so
the brand domain is never associated with the operations endpoint.

## 3. Deploy on a VPS

```bash
# Node 22 LTS + PostgreSQL 16, both pinned by your distro's package set
sudo apt install -y postgresql-16 nginx certbot python3-certbot-nginx

sudo -u postgres psql <<'SQL'
CREATE DATABASE aurum;
CREATE USER aurum_app WITH PASSWORD '<strong-password>';
-- least privilege: the app owns its tables, nothing else
GRANT ALL PRIVILEGES ON DATABASE aurum TO aurum_app;
SQL

git clone <your-fork> /opt/aurum && cd /opt/aurum
cp .env.example .env     # fill in every value; chmod 600 .env
npm ci
npx drizzle-kit push
npm run build
```

`systemd` unit `/etc/systemd/system/aurum.service`:

```ini
[Unit]
Description=Aurum Bespoke Outreach
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/aurum
EnvironmentFile=/opt/aurum/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
User=aurum
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/aurum/.next

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now aurum
sudo certbot --nginx -d outreach.aurumbespoke.com   # nginx proxy_pass to 127.0.0.1:3000
```

Restart safety: jobs, suppressions and the notification outbox all live in PostgreSQL,
so a restart loses nothing. Recurring work is re-enqueued with time-bucketed idempotency
keys, so a double start cannot double-schedule.

## 4. External scheduler (alternative)

```
SCHEDULER_ENABLED=0
CRON_SECRET=<openssl rand -hex 32>
```

```bash
*/2 * * * * curl -fsS -X POST https://outreach.aurumbespoke.com/api/cron \
  -H "x-cron-secret: $CRON_SECRET" >/dev/null
```

## 5. Dependency pinning

`package.json` pins exact versions (no `^`, no `~`); `package-lock.json` is committed.
No container image is referenced by a mutable `latest` tag. If you containerise, pin the
base image by digest:

```dockerfile
FROM node:22.11.0-bookworm-slim@sha256:<digest>
```

## 6. Backup

```bash
# nightly, 02:30 IST, encrypted, 30-day retention
30 2 * * * pg_dump -Fc aurum | age -r <age-public-key> \
  > /var/backups/aurum-$(date +\%F).dump.age
```

Back up separately and offline: `.env` (contains `TOKEN_ENCRYPTION_KEY`).
**Without that key the stored Gmail refresh token is unrecoverable** — you would simply
re-run "Connect Gmail", which is safe but requires manual action.

## 7. Restore

```bash
systemctl stop aurum
age -d -i <key> aurum-YYYY-MM-DD.dump.age | pg_restore -d aurum --clean --if-exists
systemctl start aurum
```

Post-restore checks:

1. `GET /api/health` → `checks.database.ok` and `checks.gmail.ok`.
2. Suppression count matches the pre-incident figure — if not, **do not resume sending**.
3. Leave `emergencyStop` **on** until step 2 passes, then clear it and re-enable sending.

## 8. Disaster recovery target

* RPO: 24 h (nightly dump). Tighten with WAL archiving if required.
* RTO: ~30 min (provision + restore + reauthorise Gmail).
