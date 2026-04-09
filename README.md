# Beacon

A trustless randomness relay that brings [drand](https://drand.love) onto Stellar. Any Soroban contract can read provably unbiased, verifiable randomness with a single cross-contract call.

**Live on Stellar testnet:**
- Verifier contract: `CAHK3UIQJM63WD2YOU6W6V3AVCVM3QNYPCFMU7KIJMRRIOEURRRWCIN6`
- Dice game contract: `CCP4B6RX7RH3OM7AVY5VO2COZK2JTEPE4W5YJ2X7Q5GV6QK77O4YFPKD`

---

## Why

Soroban's built-in `env.prng()` is seeded from the ledger hash — all transactions in the same ledger see the same value, and validators can bias the output. Soroban contracts also can't make HTTP calls, so there was no way to bring external randomness on-chain without a relay.

Beacon solves this by verifying drand's threshold BLS signature on-chain. The randomness requires ≥⅔ of the League of Entropy (Cloudflare, Protocol Labs, EPFL, and others) to collude before it can be biased.

---

## How it works

```
drand quicknet  (threshold BLS beacon, 3-second period)
  │  round N + BLS G1 signature (48 bytes compressed)
  ▼
feeder  (Node.js, /feeder)
  ① polls api.drand.sh every 3 seconds
  ② decompresses G1 sig: 48 bytes → 96 bytes (Soroban format)
  ③ calls verifier.push(round, sig) on Stellar
  ④ serves REST API: GET /random, GET /feed, GET /random/:round
  ▼
drand verifier contract  (Soroban / Rust, /contracts/drand-verifier)
  ① msg    = sha256(round as big-endian u64)
  ② H(msg) = hash_to_g1(msg, DST)             hash-to-curve, RFC 9380
  ③ valid  = pairing_check([sig, H(msg)], [−g₂, pk])    CAP-0059
  ④ if valid → store  randomness[round] = sha256(sig)
  ▼
any Soroban contract  ──cross-contract call──▶  verifier.get(round)
```

The BLS pairing check runs as a native host function (CAP-0059, Protocol 22+) — no trusted intermediary, the math is the trust anchor.

---

## Project structure

```
beacon/
├── contracts/
│   ├── drand-verifier/     # BLS12-381 on-chain verifier (Soroban/Rust)
│   └── dice-game/          # Commit/reveal dice game (Soroban/Rust)
├── feeder/
│   └── src/
│       ├── index.ts        # Poll loop + push queue
│       ├── drand.ts        # drand API client
│       ├── soroban.ts      # Transaction builder + submitter
│       └── server.ts       # Express REST API
├── frontend/
│   └── src/
│       ├── App.tsx
│       ├── wallet.ts       # StellarWalletsKit v2 helpers
│       └── components/
│           ├── RandomFetcher.tsx
│           ├── DiceGame.tsx
│           ├── BeaconFeed.tsx
│           └── HowItWorks.tsx
└── Cargo.toml              # Rust workspace
```

---

## Use in your own Soroban contract

No crate dependency needed — just define the interface inline:

```rust
use soroban_sdk::{contractclient, Address, BytesN, Env};

#[contractclient(name = "DrandVerifierClient")]
pub trait DrandVerifier {
    fn get(env: Env, round: u64) -> Option<BytesN<32>>;
    fn latest(env: Env) -> (u64, BytesN<32>);
}
```

Then use commit/reveal to prevent front-running:

```rust
const VERIFIER: &str = "CAHK3UIQJM63WD2YOU6W6V3AVCVM3QNYPCFMU7KIJMRRIOEURRRWCIN6";
const GENESIS: u64 = 1_692_803_367;
const PERIOD:  u64 = 3;
const BUFFER:  u64 = 10;

// Phase 1: commit to a future round (randomness doesn't exist yet)
pub fn start(env: Env, user: Address, target_round: u64) {
    user.require_auth();
    let now     = env.ledger().timestamp();
    let current = (now.saturating_sub(GENESIS)) / PERIOD + 1;
    assert!(target_round >= current + BUFFER, "round must be in the future");
    env.storage().persistent().set(&user, &target_round);
}

// Phase 2: reveal after feeder has pushed target_round
pub fn reveal(env: Env, user: Address) -> u32 {
    let round: u64 = env.storage().persistent().get(&user).unwrap();
    let verifier   = Address::from_str(&env, VERIFIER);
    let client     = DrandVerifierClient::new(&env, &verifier);
    let rand       = client.get(&round).expect("round not yet available");
    (rand.get(0).unwrap() % 100) as u32  // 0–99
}
```

**Why commit to a future round?** If you used the current round's randomness directly, anyone could look it up before submitting their transaction and pick whichever round gives them the result they want. Committing to a round that doesn't exist yet makes the outcome unknown at commit time.

Poll from your frontend until the round is available:

```typescript
async function waitForRound(targetRound: number): Promise<void> {
  while (true) {
    const res = await fetch(`http://your-feeder/random/${targetRound}`);
    if (res.ok) return;
    await new Promise(r => setTimeout(r, 3000));
  }
}
```

---

## Running locally

### Prerequisites

- Rust + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli)
- Node.js 20+

### 1. Build and deploy contracts

```bash
stellar keys generate --global feeder --network testnet --fund

stellar contract build

stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/drand_verifier.wasm \
  --source feeder --network testnet
# → save as VERIFIER_CONTRACT_ID

stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/dice_game.wasm \
  --source feeder --network testnet \
  -- --verifier $VERIFIER_CONTRACT_ID
# → save as DICE_CONTRACT_ID
```

### 2. Configure and run the feeder

```bash
cp feeder/.env.example feeder/.env
# fill in FEEDER_SECRET_KEY, VERIFIER_CONTRACT_ID, DICE_CONTRACT_ID

cd feeder && npm install && npm run feeder
```

### 3. Run the frontend

```bash
cp frontend/.env.example frontend/.env
# fill in VITE_VERIFIER_CONTRACT_ID, VITE_DICE_CONTRACT_ID

cd frontend && npm install && npm run dev
```

---

## Feeder REST API

| Endpoint | Description |
|----------|-------------|
| `GET /random` | Latest verified round `{ round, randomness, timestamp }` |
| `GET /random/:round` | Specific round (404 if not yet verified) |
| `GET /feed` | Last 50 verified rounds, newest first |

---

## drand quicknet details

| Property | Value |
|----------|-------|
| Chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Scheme | `bls-unchained-g1-rfc9380` |
| Period | 3 seconds |
| Signature | G1, 48 bytes compressed |
| Public key | G2, 96 bytes |
| Genesis | 1692803367 (Unix) |

---

## Tech stack

- **Contracts**: Soroban (Rust), `soroban-sdk 25.3.1`
- **Feeder**: Node.js, TypeScript, `@stellar/stellar-sdk 15.0.1`, `@noble/curves`
- **Frontend**: React 18, Vite, Tailwind CSS, StellarWalletsKit v2
- **Cryptography**: BLS12-381 pairing check (CAP-0059), hash-to-curve RFC 9380
