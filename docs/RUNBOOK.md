# Beacon — VPS deploy runbook

Step-by-step guide to host the beacon feeder on an Ubuntu VPS (Hostinger or any
other provider) so it serves the canonical testnet endpoint at
`https://<your-subdomain>.duckdns.org`.

This is written for someone who has never administered a Linux VPS. Every
command has a short note on what it does and what output you should see. Copy
them one block at a time — don't paste the whole file.

> Anywhere you see `<DUCKDNS_SUBDOMAIN>`, replace it with the DuckDNS name you
> reserved (e.g. `stellardrand`). Anywhere you see `<VPS_IP>`, replace with the
> VPS public IP from your Hostinger panel.

---

## Step 0 — What you'll need at hand

- Hostinger account with a VPS (Ubuntu 22.04 or 24.04)
- A DuckDNS subdomain (free, see Step 2)
- The feeder Stellar secret key (the operator hands this to you separately —
  it's not in the repo, never commit it anywhere)
- The verifier + dice game contract IDs (already baked into `.env.example`,
  no action needed unless you redeployed them)

---

## Step 1 — Connect to your VPS

Two ways. The browser option needs zero local setup.

### Option A — Hostinger browser terminal (easiest)

1. Go to `hpanel.hostinger.com`.
2. Click **VPS** in the sidebar, pick your VPS.
3. On the VPS overview page click **Browser terminal** (sometimes labelled
   "Open terminal" or "SSH access"). A black terminal pane opens in the
   browser, already logged in as `root`.
4. Note down the **public IP** shown on the same page — you'll need it for
   DuckDNS.

### Option B — SSH from your laptop

```bash
ssh root@<VPS_IP>
```

Use the root password Hostinger gave you (or your SSH key if you uploaded one).
On macOS use Terminal.app; on Windows use PowerShell or Windows Terminal.

You're now in a shell on the VPS. Everything below runs there unless explicitly
marked "(on your laptop)".

---

## Step 2 — Reserve a DuckDNS subdomain (on your laptop)

1. Open https://www.duckdns.org in a browser.
2. Click **Sign in with GitHub** (or Google, Reddit — any works).
3. Under **domains**, type a name (e.g. `stellardrand`) and click **add
   domain**. You now own `stellardrand.duckdns.org`.
4. Paste your VPS public IP into the **current ip** field next to your domain
   and click **update ip**.
5. Verify it resolves (on your laptop):
   ```bash
   ping <DUCKDNS_SUBDOMAIN>.duckdns.org
   ```
   You should see your VPS IP. If not, wait 30 seconds and try again — DNS
   takes a moment.

---

## Step 3 — Verify the VPS OS

(All steps from here are in the VPS terminal.)

```bash
cat /etc/os-release
```

You should see `Ubuntu 22.04` or `Ubuntu 24.04`. If something else, stop and
tell Claude — the package names might differ.

---

## Step 4 — Update the system

```bash
apt-get update && apt-get upgrade -y
```

This refreshes the package list and installs all pending security updates.
Takes 1–3 minutes. If a blue/purple dialog appears asking about config files,
just press **Enter** to keep the default.

---

## Step 5 — Install Docker

Docker runs the feeder in a sandboxed container so you don't have to manage
Node.js manually. The command below runs Docker's official one-line installer.

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker --version
```

Expected output of the last command: `Docker version 27.x.x` (or higher).
`systemctl enable --now docker` makes Docker start automatically on every
reboot, so you never need to think about it again.

---

## Step 6 — Install Caddy (auto-HTTPS reverse proxy)

Caddy sits in front of the feeder, terminates HTTPS using a free Let's Encrypt
certificate, and forwards traffic to the feeder container. It renews the
certificate automatically — set-and-forget.

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
systemctl enable --now caddy
caddy version
```

Expected output: `v2.x.x ...`.

---

## Step 7 — Configure the firewall

Only allow SSH (22), HTTP (80, needed for Let's Encrypt domain check), and
HTTPS (443). The feeder's own port 3001 is bound to localhost only — outside
traffic must come through Caddy.

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

`ufw status` should list those three lines as `ALLOW`. **Don't lock yourself
out:** if you're connected via SSH, make sure `22/tcp` appears in the allow
list before enabling.

---

## Step 8 — Clone the beacon repo on the VPS

```bash
git clone https://github.com/kaankacar/Drand-Relay.git /opt/beacon
cd /opt/beacon/feeder
```

`/opt` is the conventional place for self-managed services on Linux.

---

## Step 9 — Create the feeder `.env` (with 3 channel-account secrets)

The feeder uses a **channel-accounts** pattern: 3 separate Stellar testnet keypairs that share the push load. Stellar caps each source account at 1 tx per ledger (a Soroban-era protocol rule covering all submission), so a single signer maxes at ~12 tx/min vs drand's 20/min — too slow. Three channels gives ~36 tx/min capacity with margin.

Generate the 3 channel accounts on your local machine and fund them via friendbot:

```bash
for n in a b c; do stellar keys generate beacon-channel-$n --network testnet --fund; done
```

Then list their secret keys (you'll paste them into the VPS):

```bash
for n in a b c; do echo "CHANNEL_$(echo $n | tr a-z A-Z)_SECRET=$(stellar keys show beacon-channel-$n)"; done
```

On the VPS, paste this single-line command, replacing the three `<S_…>` placeholders with the real secret values:

```
printf '%s\n' 'SOROBAN_RPC_URL=https://soroban-testnet.stellar.org' 'NETWORK_PASSPHRASE=Test SDF Network ; September 2015' 'VERIFIER_CONTRACT_ID=CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM' 'DICE_CONTRACT_ID=CCBHSZD3AR6DQMPXBUAT5RELARIMFPZEN6ZLC3SIHU6UQOLUCB35LYUI' 'PORT=3001' 'DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971' 'CHANNEL_A_SECRET=<S_CHANNEL_A>' 'CHANNEL_B_SECRET=<S_CHANNEL_B>' 'CHANNEL_C_SECRET=<S_CHANNEL_C>' > /opt/beacon/feeder/.env && chmod 600 /opt/beacon/feeder/.env
```

---

## Step 10 — Start the feeder with Docker Compose

```bash
cd /opt/beacon/feeder
docker compose up -d --build
docker compose ps
```

First run takes ~1 minute (pulls Node 20 alpine, installs deps, builds the feeder image).

`docker compose ps` should show a single container as `Up`:

```
NAME            IMAGE           STATUS
beacon-feeder   feeder-feeder   Up
```

Check feeder logs:

```bash
docker logs -f beacon-feeder
```

Within ~15 seconds you should see lines like:
```
[feeder] starting drand quicknet feeder
[feeder] queuing round NNNNNN
[feeder] → ch-a round NNNNNN sent — tx abc123def…
[feeder] → ch-b round NNNNNN+1 sent — tx 456fedcba…
[feeder] → ch-c round NNNNNN+2 sent — tx 7890aaabbb…
[feeder] → ch-a round NNNNNN+3 sent — tx cccdddeee…
```

The rotation across `ch-a / ch-b / ch-c` is what unlocks the throughput — each channel account submits 1 tx/ledger; 3 of them in parallel cover drand's 20-rounds-per-minute rate with room to spare. Press **Ctrl+C** to leave the log view (the container keeps running).

If you see errors:
- `No CHANNEL_*_SECRET configured` — one of the three secrets is missing from `.env`. Re-check with `grep CHANNEL_ /opt/beacon/feeder/.env`.
- `simulation failed` or `account not found` — one of the channel keypairs isn't funded on testnet; re-run friendbot for that public address.
- `tx_bad_seq` (rare, recoverable) — the feeder will drop that channel's sequence cache and reload from the network on the next attempt. Should self-heal within a few rounds.

---

## Step 11 — Configure Caddy with HTTPS

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
<DUCKDNS_SUBDOMAIN>.duckdns.org {
    reverse_proxy 127.0.0.1:3001
    encode gzip
}
EOF
```

(Replace `<DUCKDNS_SUBDOMAIN>` with your actual subdomain before pasting — or
edit afterwards with `nano /etc/caddy/Caddyfile`.)

> **Do not add a `header { Access-Control-Allow-Origin "*" ... }` block here.**
> The feeder's Express app already emits CORS headers via the `cors()`
> middleware (see `feeder/src/server.ts`). Adding them again in Caddy produces
> **two** `Access-Control-Allow-Origin` headers on every response, which Chrome
> rejects with `TypeError: Failed to fetch` and breaks any browser client (the
> live demo included). One source of CORS truth — the application — is enough.

Reload Caddy to pick up the config:

```bash
systemctl reload caddy
journalctl -u caddy -n 30 --no-pager
```

The journalctl output should show `certificate obtained successfully` within
~30 seconds. If you see Let's Encrypt errors, the most common cause is the
DuckDNS subdomain not pointing at this VPS IP yet — re-check Step 2.

---

## Step 12 — Verify the public endpoint works

From anywhere (your laptop, or the VPS):

```bash
curl -s https://<DUCKDNS_SUBDOMAIN>.duckdns.org/random | jq
```

Expected:
```json
{
  "round": 28500000,
  "randomness": "0xba98...",
  "timestamp": "2026-05-11T..."
}
```

The `timestamp` should be within the last 30 seconds. If you see this, the
feeder is live and serving traffic over HTTPS. 🎉

---

## Step 13 — Auto-restart on failure (healthcheck cron)

If the feeder ever stops responding (drand outage, network blip), this cron
restarts the container.

```bash
cat > /etc/cron.d/beacon-health <<EOF
*/5 * * * * root curl -fsS https://<DUCKDNS_SUBDOMAIN>.duckdns.org/random > /dev/null 2>&1 || (cd /opt/beacon/feeder && docker compose restart) 2>&1 | logger -t beacon-health
EOF
chmod 644 /etc/cron.d/beacon-health
```

(Edit `<DUCKDNS_SUBDOMAIN>` first.) Every 5 minutes, this hits `/random`; if
the response fails, it restarts the docker container and logs the action to
the system journal.

To see if it ever fires:
```bash
journalctl -t beacon-health -n 50 --no-pager
```

---

## Step 14 — Weekly friendbot refill for all 3 channel accounts

Each push costs ~45,475 stroops. With 3 channel accounts each pushing 1 round
per ledger (~12 rounds/min apiece), each one drains ~44 XLM/day. This cron
tops up all three every Sunday at midnight UTC.

```bash
cat > /etc/cron.d/beacon-friendbot <<'EOF'
0 0 * * 0 root for addr in G_CHANNEL_A_PUBKEY G_CHANNEL_B_PUBKEY G_CHANNEL_C_PUBKEY; do curl -fsS "https://friendbot.stellar.org/?addr=$addr" > /dev/null 2>&1; done | logger -t beacon-friendbot
EOF
chmod 644 /etc/cron.d/beacon-friendbot
```

Replace each `G_CHANNEL_X_PUBKEY` with the corresponding channel account's public address (`stellar keys address beacon-channel-{a,b,c}`).

---

## Maintenance / troubleshooting cheatsheet

**See live feeder logs**
```bash
docker logs -f beacon-feeder
```

**Restart the feeder manually**
```bash
cd /opt/beacon/feeder && docker compose restart
```

**Update to a newer beacon release**
```bash
cd /opt/beacon
git pull
cd feeder
docker compose up -d --build
```

**See Caddy logs / cert renewal status**
```bash
journalctl -u caddy -n 100 --no-pager
```

**Reboot the whole VPS** — Docker and Caddy auto-start, the feeder resumes
within ~30 seconds:
```bash
reboot
```

**Check feeder XLM balance**
```bash
curl -s https://horizon-testnet.stellar.org/accounts/GDKQ55QFCW7NMR2JTYSXCWLRHMEVBVV2667FYRRCKEPRWMIBK2M32VH6 | jq '.balances[0].balance'
```

(Or whichever account you're using as the feeder.)

---

## What's running where

| Piece | Lives on | How it auto-recovers |
|-------|----------|----------------------|
| Feeder container | Docker, port 127.0.0.1:3001 | `restart: unless-stopped` in docker-compose |
| Caddy reverse proxy | systemd, ports 80 + 443 | `systemctl enable` — restarts on boot |
| Healthcheck | cron, every 5 min | Restarts container if /random fails |
| Friendbot refill | cron, weekly | Tops up testnet XLM automatically |
| Docker daemon | systemd | `systemctl enable` — starts on boot |
