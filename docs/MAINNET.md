# Mainnet deploy guide

This document explains how to run Drand-Relay against **Stellar mainnet** instead of testnet — i.e., how to spin up a verifier contract and feeder that mainnet dApps can consume.

> **Mainnet costs real money.** Read [Operating costs](../README.md#operating-costs) in the root README first. At today's XLM price, expect **~$90 to $400 per week** depending on price and rate.

This guide assumes you've already deployed on testnet using [`RUNBOOK.md`](RUNBOOK.md). The steps mirror it 1:1 — the differences are highlighted below.

---

## What's different from testnet

| | Testnet | Mainnet |
|---|---|---|
| RPC URL | `https://soroban-testnet.stellar.org` | `https://mainnet.sorobanrpc.com` *(or another provider)* |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| Account funding | Free via friendbot | Buy XLM and send it |
| Auto top-up | Weekly friendbot cron | Manual or scripted — no free refills |
| Mistakes | Cheap, just redeploy | Cost real XLM; double-check everything |
| drand chain | quicknet (same) | quicknet (same) |

The contract code itself is **identical**. drand quicknet is a public network; the same BLS pairing check and public key work everywhere.

---

## Step 1 — Pick a mainnet RPC provider

Soroban mainnet RPC is not run by SDF directly. Pick one of:

| Provider | Cost | Notes |
|---|---|---|
| [Validation Cloud](https://www.validationcloud.io) | Free tier | Generous free quota, good latency |
| [BlockDaemon](https://www.blockdaemon.com) | Free + paid | Enterprise SLA available |
| [Quicknode](https://www.quicknode.com) | Free + paid | Good if you already have a Quicknode account |
| Self-hosted `stellar-rpc` | Server costs | Most control, most work |

Whichever you pick, you'll get a URL like `https://mainnet.sorobanrpc.com/v1/...` — call it `MAINNET_RPC_URL`.

Latency matters: the feeder needs to submit a tx within a few seconds of each drand round, so prefer providers with low round-trip time from your VPS.

---

## Step 2 — Create and fund mainnet channel accounts

You'll need **3 channel accounts** on mainnet (same pattern as testnet — Stellar caps each source account at 1 tx/ledger, so 3 channels are needed to keep up with drand's 3s round rate). All three keypairs are configured directly in the feeder's `.env` file; the deployer key from Step 3 stays separate.

On your local machine:

```bash
for n in a b c; do
  stellar keys generate beacon-channel-$n-mainnet \
    --network-passphrase "Public Global Stellar Network ; September 2015" \
    --rpc-url https://mainnet.sorobanrpc.com   # your provider's URL
  echo "Channel $n pub: $(stellar keys address beacon-channel-$n-mainnet)"
done
```

Buy XLM (Coinbase, Binance, Kraken, etc.) and send it to each address. Because the total network spend is split across 3 accounts, divide your runway budget by 3 per account:

- **~1,700 XLM per channel × 3 ≈ 5,000 XLM total** to start (~1.5 months of operation plus buffer)
- **~8,500 XLM per channel × 3 ≈ 25,000 XLM total** if you want 6 months of runway without refunding
- Plus **a few hundred XLM** in a separate hot top-up account if you script auto-refills (per Step 5 Option B)

Total monthly cost is unchanged from a single-account setup (~3,930 XLM/mo at current rates) — channel accounts split the network's tx volume across multiple signers, they don't multiply spend.

Verify each account is funded:

```bash
for n in a b c; do
  ADDR=$(stellar keys address beacon-channel-$n-mainnet)
  BAL=$(curl -s "https://horizon.stellar.org/accounts/$ADDR" | jq -r '.balances[] | select(.asset_type=="native") | .balance')
  echo "$n: $BAL XLM"
done
```

---

## Step 3 — Deploy the verifier (and optionally dice game) on mainnet

```bash
cd /path/to/Drand-Relay

# Build (same wasm as testnet)
cargo build --release --target wasm32v1-none

# Configure stellar CLI to talk to mainnet
stellar network add mainnet \
  --rpc-url https://mainnet.sorobanrpc.com \
  --network-passphrase "Public Global Stellar Network ; September 2015"

# Deploy verifier (drand-verifier.wasm; same code as testnet)
stellar contract deploy \
  --wasm target/wasm32v1-none/release/drand_verifier.wasm \
  --source beacon-feeder-mainnet --network mainnet
# → save as MAINNET_VERIFIER_CONTRACT_ID
```

**Costs:** Deploying a contract on mainnet costs more than a single push — typically 1–2 XLM for the deploy + WASM upload, vs. ~0.005 XLM per push. One-off.

Save the contract ID — you'll publish it so dApps know where to read randomness from.

---

## Step 4 — Set up the VPS (same as testnet)

Follow [`RUNBOOK.md`](RUNBOOK.md) Steps 1–8 verbatim. The only difference is the `.env` file in Step 9 — use mainnet values:

```bash
cat > /opt/beacon/feeder/.env <<'EOF'
FEEDER_SECRET_KEY=S...your-mainnet-secret
SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com   # your provider URL
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
VERIFIER_CONTRACT_ID=C...your-mainnet-verifier
DICE_CONTRACT_ID=                                # (optional)
PORT=3001
DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
EOF
chmod 600 /opt/beacon/feeder/.env
```

Then continue with Steps 10–13 (Docker compose, Caddy, healthcheck cron) exactly as in the testnet guide.

**Don't run the weekly friendbot cron from Step 14.** There's no friendbot on mainnet — see Step 5 for refilling.

---

## Step 5 — Funding and monitoring

The feeder will slowly drain its XLM balance — ~131 XLM/day at the current rate. You have three options to keep it topped up:

### Option A — Manual periodic top-ups (simplest)

Check the balance once a month, send more XLM when it gets low:

```bash
# On the VPS
curl -s "https://horizon.stellar.org/accounts/G...feeder-mainnet" \
  | jq '.balances[0].balance'
```

Set a calendar reminder. Pros: zero automation risk. Cons: human in the loop.

### Option B — Automated top-up from a hot wallet

Hold a separate **top-up account** with a larger balance, and cron a script that transfers XLM to the feeder if its balance drops below a threshold.

```bash
# /etc/cron.d/beacon-mainnet-topup (example only)
0 */6 * * * root /opt/beacon/scripts/topup.sh 2>&1 | logger -t beacon-topup
```

`topup.sh` would:
1. Query feeder balance via Horizon.
2. If below threshold (e.g., 500 XLM), send a payment of e.g. 2,000 XLM from the top-up account.
3. Log every action.

This means the **top-up account's secret is also on the VPS**. Trade-off: convenience vs. blast radius. Keep the top-up account's balance bounded.

### Option C — Cold-wallet refills (most secure)

Hold the bulk of your XLM in a hardware wallet or multisig. Refill the feeder manually from cold storage every N weeks. Use Option A's monitoring with email alerts (e.g., via a simple cron that sends mail when balance drops below threshold).

For a public-good service this is usually overkill. For a custom commercial deployment, recommended.

### Alerting on stalls

The healthcheck cron from RUNBOOK Step 13 restarts the feeder if `/random` stops responding. For mainnet you probably also want **balance alerting**:

```bash
# /etc/cron.d/beacon-mainnet-balance-alert
0 */6 * * * root BAL=$(curl -s "https://horizon.stellar.org/accounts/G..." | jq -r '.balances[0].balance' | cut -d. -f1); [ "$BAL" -lt 500 ] && curl -s -X POST "https://hooks.slack.com/services/..." -d '{"text":"Beacon mainnet feeder balance low: '$BAL' XLM"}' 2>&1 | logger -t beacon-balance
```

(Replace with your alerting webhook of choice — Slack, Discord, PagerDuty, etc.)

---

## Step 6 — Verify everything works

Same end-to-end check as testnet, just on mainnet:

```bash
# 1. Feeder serving HTTPS
curl -s https://your-mainnet-feeder.example.com/random | jq

# 2. On-chain randomness matches drand
ROUND=$(curl -s https://your-mainnet-feeder.example.com/random | jq -r .round)
ON_CHAIN=$(curl -s https://your-mainnet-feeder.example.com/random/$ROUND | jq -r .randomness)
DRAND=$(curl -s https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/$ROUND | jq -r .randomness)
[ "${ON_CHAIN#0x}" = "$DRAND" ] && echo "✓ matches" || echo "✗ MISMATCH"

# 3. Cross-contract read from mainnet
stellar contract invoke --id $MAINNET_VERIFIER_CONTRACT_ID \
  --network mainnet --source $SOME_FUNDED_MAINNET_KEY \
  --send=no -- get --round $ROUND
```

---

## Operational checklist

Before announcing your mainnet deployment publicly:

- [ ] Verifier contract deployed and emitting `push` events for ~10 minutes
- [ ] On-chain randomness verified byte-for-byte against drand for 3+ different rounds
- [ ] Feeder VPS has at least 2 weeks of runway in XLM
- [ ] Healthcheck cron is configured and tested (manually stop docker → confirm it restarts within 5 min)
- [ ] Balance alerting wired up to a channel you actually check
- [ ] Caddy has obtained a valid Let's Encrypt cert (check `journalctl -u caddy | grep certificate`)
- [ ] Endpoint reachable from outside your VPS network (test from another machine)
- [ ] You've documented the mainnet verifier address and feeder URL somewhere public (this repo's README, your project docs, etc.)
- [ ] You've notified yourself how to react when the cert renews (Caddy handles it but log monitoring helps)

---

## Mainnet vs. testnet: what stays the same

These are identical, no changes needed:

- The Rust contract code (`contracts/drand-verifier/src/lib.rs`)
- The feeder TypeScript code (`feeder/src/*`)
- The drand quicknet chain hash and public key (drand quicknet is one global network)
- The BLS verification flow
- Docker / Caddy / firewall setup
- The integration interface developers use:
  ```rust
  fn get(env: Env, round: u64) -> Option<BytesN<32>>;
  fn latest(env: Env) -> Option<(u64, BytesN<32>)>;
  ```

That last point is the key one: **a contract written against the canonical testnet verifier can switch to a mainnet verifier just by changing the address constant.** Same API, same semantics, same randomness source.

---

## When NOT to do mainnet

- If you're prototyping → use the canonical testnet endpoint instead, free.
- If you can't commit to refilling XLM for the foreseeable future → either don't deploy, or use [Option C](#option-c--cold-wallet-refills-most-secure) and budget aggressively.
- If you don't have monitoring/oncall → seriously consider whether a stalled relay would hurt your users more than not having one. Liveness is on you.

Drand-Relay's trust model means **a stalled feeder can't bias randomness, only block it**. But for dApps doing time-sensitive operations (lotteries with draw deadlines, etc.), a stall is still a real problem.
