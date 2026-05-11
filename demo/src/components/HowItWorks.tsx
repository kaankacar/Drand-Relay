import React, { useState } from "react";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white uppercase tracking-wide">{title}</h3>
      <div className="text-sm text-gray-400 space-y-2 leading-relaxed">{children}</div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-gray-800 text-violet-300 rounded px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}

function Block({ lang, children }: { lang?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(children.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="relative group">
      {lang && (
        <div className="bg-gray-700 rounded-t-xl px-3 py-1 text-xs text-gray-400 font-mono border-b border-gray-600">
          {lang}
        </div>
      )}
      <pre className={`bg-gray-800 ${lang ? "rounded-b-xl" : "rounded-xl"} p-4 text-xs font-mono text-gray-300 overflow-x-auto leading-relaxed whitespace-pre`}>
        {children.trim()}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 text-gray-600 hover:text-gray-300 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 rounded-2xl p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function HowItWorks() {
  return (
    <div className="space-y-6">

      {/* ── What this is ── */}
      <Card title="What Beacon is">
        <Section title="The one-sentence version">
          <p>
            Beacon fetches publicly verifiable randomness from{" "}
            <a href="https://drand.love" target="_blank" rel="noreferrer" className="text-violet-400 underline">drand</a>{" "}
            every 3 seconds and verifies it on Stellar using a BLS12-381 pairing check — so any Soroban
            contract can read provably unbiased randomness with a single cross-contract call.
          </p>
        </Section>

        <Section title="Why not use env.prng()?">
          <p>
            Soroban's built-in <Code>env.prng()</Code> is seeded from the ledger hash, which has two
            known weaknesses:
          </p>
          <ul className="list-disc list-inside space-y-1 pl-2">
            <li>All transactions in the same ledger see the same "random" value — an attacker can pick the winner by submitting many transactions.</li>
            <li>Validators influence the ledger hash and can bias the output.</li>
          </ul>
          <p>
            Drand's threshold BLS signature requires ≥⅔ of the League of Entropy (Cloudflare, Protocol
            Labs, EPFL…) to collude before it can be biased. Use Beacon for anything where the stakes
            justify it.
          </p>
        </Section>
      </Card>

      {/* ── Architecture ── */}
      <Card title="System architecture">
        <Block lang="text">{`
drand quicknet  (League of Entropy threshold beacon, 3-second period)
  │  produces: round N + BLS G1 signature (48 bytes compressed)
  ▼
feeder  (Node.js / TypeScript, this repo /feeder)
  ① polls api.drand.sh/…/public/latest every 3 seconds
  ② decompresses G1 sig: 48 bytes → 96 bytes (Soroban format)
  ③ calls verifier.push(round, sig_compressed, sig_uncompressed) on Stellar
  ④ also serves a REST API: GET /random, GET /feed, GET /random/:round
  ▼
drand verifier contract  (Soroban / Rust, /contracts/drand-verifier)
  ① bind compressed ↔ uncompressed encodings (X bytes + y-sign)
  ② msg    = sha256(round as big-endian u64)
  ③ H(msg) = hash_to_g1(msg, DST)             hash-to-curve, RFC 9380
  ④ valid  = pairing_check([sig, H(msg)], [−g₂, pk])    CAP-0059
  ⑤ if valid → store  randomness[round] = sha256(sig_compressed)
                                          ↑ matches api.drand.sh
  ▼
any Soroban contract  ──cross-contract call──▶  verifier.get(round)
        `}</Block>

        <Section title="Canonical Stellar testnet deployment">
          <div className="space-y-1 font-mono text-xs">
            <p><span className="text-gray-500">Verifier  </span><span className="text-gray-200 break-all">CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM</span></p>
            <p><span className="text-gray-500">Dice game </span><span className="text-gray-200 break-all">CCBHSZD3AR6DQMPXBUAT5RELARIMFPZEN6ZLC3SIHU6UQOLUCB35LYUI</span></p>
            <p><span className="text-gray-500">drand     </span><span className="text-gray-200">quicknet · bls-unchained-g1-rfc9380 · 3s period</span></p>
          </div>
        </Section>
      </Card>

      {/* ── BLS math ── */}
      <Card title="BLS12-381 verification (CAP-0059)" subtitle="How push() knows the signature is genuine">
        <Section title="The pairing check equation">
          <p>
            A BLS signature σ on message m with public key pk satisfies:{" "}
            <Code>e(σ, g₂) == e(H(m), pk)</Code>. We rearrange it for Soroban's
            two-Vec API:
          </p>
          <Block lang="rust">{`
// msg = sha256(round as big-endian u64)
let msg_hash: BytesN<32> = env.crypto().sha256(&round_bytes).into();

// H(msg) = hash-to-G1 with drand's DST (RFC 9380)
let bls    = env.crypto().bls12_381();
let msg_g1 = bls.hash_to_g1(&msg_hash.into(), &dst);

// Decode points (Soroban format: uncompressed, no flag bits)
let sig_g1     = G1Affine::from_bytes(signature);          // 96 bytes
let neg_gen_g2 = G2Affine::from_bytes(NEG_G2_GEN_BYTES);  // 192 bytes
let pk_g2      = G2Affine::from_bytes(DRAND_PK_BYTES);     // 192 bytes

// e(σ, −g₂) · e(H(m), pk) == 1
let valid = bls.pairing_check(
    vec![&env, sig_g1, msg_g1],
    vec![&env, neg_gen_g2, pk_g2],
);
          `}</Block>
          <p>
            The pairing check runs in the host VM (not WASM) — it's a native call that would otherwise
            be far too expensive to implement in a contract directly.
          </p>
        </Section>

        <Section title="Why randomness = sha256(compressed signature)">
          <p>
            The signature itself is a valid group element — hashing it first gives uniform 32-byte output.
            The contract hashes the canonical 48-byte compressed encoding, which is exactly what
            <Code>api.drand.sh</Code> hashes for its published <Code>randomness</Code> field, so on-chain
            and off-chain values match round-for-round. The feeder sends both compressed and uncompressed
            forms and the contract checks they describe the same point before trusting either.
          </p>
        </Section>
      </Card>

      {/* ── Commit/Reveal ── */}
      <Card title="How the dice game uses commit / reveal">
        <Section title="Why not just read the current round?">
          <p>
            If the dice game used <Code>verifier.latest()</Code> directly, anyone could look up the
            current randomness before submitting their transaction, pick the round that gives them a 6,
            and win every time. Commit/reveal prevents this.
          </p>
        </Section>

        <Block lang="text">{`
Phase 1 — COMMIT  (dice_game.roll)
  Player calls roll(player, target_round)
  target_round must be current_round + ≥10 (enforced on-chain)
  → stored: { player, target_round, settled: false }
  At commit time, target_round's randomness does NOT exist yet.

Phase 2 — WAIT  (~60 seconds in this app)
  The feeder pushes target_round to verifier.push()
  verifier stores: randomness[target_round] = sha256(sig_compressed)

Phase 3 — REVEAL  (dice_game.settle)
  Cross-contract call: verifier.get(target_round) → BytesN<32>
  result = rand[0] % 6 + 1
  Stored in player's history, DiceRoll event emitted.
        `}</Block>

        <Section title="Trust properties">
          <ul className="list-disc list-inside space-y-1 pl-2">
            <li><strong className="text-gray-200">Player can't cheat:</strong> they commit before the randomness exists.</li>
            <li><strong className="text-gray-200">Feeder can't cheat:</strong> it can delay pushing a round but can't change what the round contains — drand's threshold BLS ensures that.</li>
            <li><strong className="text-gray-200">On-chain verifiable:</strong> anyone can re-run the BLS pairing and confirm the stored randomness matches the signature.</li>
          </ul>
        </Section>
      </Card>

      {/* ── Use in your contract ── */}
      <Card title="Use the relay in your own Soroban contract">
        <Section title="Define the interface (no crate dep needed)">
          <Block lang="rust">{`
use soroban_sdk::{contractclient, Address, BytesN, Env};

#[contractclient(name = "DrandVerifierClient")]
pub trait DrandVerifier {
    fn get(env: Env, round: u64) -> Option<BytesN<32>>;
    fn latest(env: Env) -> Option<(u64, BytesN<32>)>;
}
          `}</Block>
        </Section>

        <Section title="Commit / reveal in your contract">
          <Block lang="rust">{`
const VERIFIER: &str = "CAHK3UIQJM63WD2YOU6W6V3AVCVM3QNYPCFMU7KIJMRRIOEURRRWCIN6";
const GENESIS: u64 = 1_692_803_367;
const PERIOD:  u64 = 3;
const BUFFER:  u64 = 10; // rounds ahead minimum

// Phase 1: commit to a future round
pub fn start(env: Env, user: Address, target_round: u64) {
    user.require_auth();
    let now     = env.ledger().timestamp();
    let current = (now.saturating_sub(GENESIS)) / PERIOD + 1;
    assert!(target_round >= current + BUFFER, "round must be in the future");
    env.storage().persistent().set(&user, &target_round);
}

// Phase 2: reveal — call after the feeder has pushed target_round
pub fn reveal(env: Env, user: Address) -> u32 {
    let round: u64 = env.storage().persistent().get(&user).unwrap();
    let verifier   = Address::from_str(&env, VERIFIER);
    let client     = DrandVerifierClient::new(&env, &verifier);
    let rand       = client.get(&round).expect("round not yet available");
    (rand.get(0).unwrap() % 100) as u32  // 0–99, or mod whatever you need
}
          `}</Block>
        </Section>

        <Section title="Check from your frontend (JavaScript)">
          <Block lang="ts">{`
// Poll until the target round is available on-chain, then call reveal()
async function waitForRound(targetRound: number): Promise<void> {
  while (true) {
    const res = await fetch(\`https://stellardrand.duckdns.org/random/\${targetRound}\`);
    if (res.ok) return; // round is verified on-chain
    await new Promise(r => setTimeout(r, 3000));
  }
}
          `}</Block>
        </Section>

        <Section title="ZK on Stellar">
          <p>
            Protocol 25 added BN254 (CAP-0074) and Poseidon (CAP-0075) — the primitives needed
            to verify Groth16 proofs on-chain. See the{" "}
            <a
              href="https://developers.stellar.org/docs/build/apps/zk"
              target="_blank"
              rel="noreferrer"
              className="text-violet-400 underline hover:text-violet-300"
            >
              Stellar ZK documentation
            </a>
            {" "}and the{" "}
            <a
              href="https://github.com/stellar/soroban-examples"
              target="_blank"
              rel="noreferrer"
              className="text-violet-400 underline hover:text-violet-300"
            >
              soroban-examples groth16_verifier
            </a>
            {" "}for the next step: replacing this drand relay with a full on-chain ZK proof of correct
            VRF computation.
          </p>
        </Section>
      </Card>

    </div>
  );
}
