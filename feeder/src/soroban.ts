/**
 * soroban.ts — submit push(round, sig_compressed, sig_uncompressed) to the
 * drand verifier contract using a channel-accounts rotation pattern.
 *
 * Why 3 channel accounts:
 *   Stellar caps each source account at 1 tx/ledger (Soroban-era rule covering
 *   both classic and Soroban tx submission). drand publishes a round every 3s
 *   while ledgers close every ~5s — a single signer can only land ~12 tx/min
 *   vs drand's 20 rounds/min, so ~40% of rounds get dropped. Rotating across
 *   3 source accounts gives ~36 tx/min capacity, comfortably above drand's
 *   rate with headroom for burst absorption.
 *
 * Each channel keypair keeps its own pre-incremented sequence cache so the
 * worker can pipeline submissions without blocking on per-tx confirmation.
 * On any tx error we drop that keypair's cache so the next attempt re-reads
 * sequence from the network.
 *
 * Signature encoding (unchanged from previous flow):
 *   drand API returns 48-byte compressed G1 (96 hex chars). The contract
 *   expects both compressed (so on-chain randomness == sha256(compressed)
 *   matches drand's published value byte-for-byte) and 96-byte uncompressed
 *   (X||Y, no flag bits) for the BLS pairing check (Soroban's host BLS API
 *   takes uncompressed input). The contract verifies they describe the same
 *   point before storing anything.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc as RpcNamespace } from "@stellar/stellar-sdk";
import { bls12_381 as bls } from "@noble/curves/bls12-381.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const VERIFIER_CONTRACT_ID = process.env.VERIFIER_CONTRACT_ID ?? "";

// Channel accounts — 3 keypairs that rotate by `round % N`.
const CHANNEL_SECRETS = [
  process.env.CHANNEL_A_SECRET ?? "",
  process.env.CHANNEL_B_SECRET ?? "",
  process.env.CHANNEL_C_SECRET ?? "",
].filter((s) => s.length > 0);

if (!VERIFIER_CONTRACT_ID) throw new Error("VERIFIER_CONTRACT_ID not set");
if (CHANNEL_SECRETS.length === 0) {
  throw new Error("No CHANNEL_*_SECRET configured (need at least one of A/B/C)");
}

export const rpc = new RpcNamespace.Server(RPC_URL);

const keypairs = CHANNEL_SECRETS.map((s) => StellarSdk.Keypair.fromSecret(s));
const channelLabel = (idx: number): string =>
  `ch-${String.fromCharCode(97 + idx)}`; // ch-a / ch-b / ch-c

/** Public key of channel A — used as the source for free read-only simulations elsewhere. */
export const READONLY_SOURCE_PUBKEY = keypairs[0].publicKey();

/** Per-keypair "most recently used sequence" — pre-incremented for back-to-back submission. */
const seqCache = new Map<string, bigint>();

async function getNextAccountFor(kp: StellarSdk.Keypair): Promise<StellarSdk.Account> {
  const pub = kp.publicKey();
  let cached = seqCache.get(pub);
  if (cached === undefined) {
    const acct = await rpc.getAccount(pub);
    cached = BigInt(acct.sequenceNumber());
    seqCache.set(pub, cached);
    return acct;
  }
  cached += 1n;
  seqCache.set(pub, cached);
  return new StellarSdk.Account(pub, cached.toString());
}

/**
 * Decompress a 48-byte compressed BLS G1 point to 96-byte Soroban format (X||Y).
 * Strips ZCash flag bits — Soroban expects raw field element bytes.
 */
function decompressG1(compressedHex: string): Buffer {
  if (compressedHex.length !== 96) {
    throw new Error(`Expected 96 hex chars (48 bytes compressed G1), got ${compressedHex.length}`);
  }
  const point = bls.G1.ProjectivePoint.fromHex(compressedHex);
  const aff = point.toAffine();

  function fpToBytes(n: bigint): Buffer {
    const buf = Buffer.alloc(48);
    let v = n;
    for (let i = 47; i >= 0; i--) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return buf;
  }

  return Buffer.concat([fpToBytes(aff.x), fpToBytes(aff.y)]);
}

/**
 * Submit a drand beacon to the verifier contract's push() function.
 *
 * Picks a channel keypair by `round % keypairs.length`, builds + simulates +
 * signs + submits the tx, and returns the tx hash immediately without polling
 * for confirmation. Stellar will include the tx in the next ledger (or reject
 * it; we detect the latter via `sendTransaction` ERROR status).
 *
 * @param round    - drand round number
 * @param sigHex   - hex-encoded BLS G1 signature from API (96 hex chars = 48 bytes compressed)
 * @returns tx hash
 */
export async function pushBeacon(round: number, sigHex: string): Promise<string> {
  const sigCompressed = Buffer.from(sigHex, "hex");
  if (sigCompressed.length !== 48) {
    throw new Error(`compressed sig must be 48 bytes, got ${sigCompressed.length}`);
  }
  const sigUncompressed = decompressG1(sigHex);

  const idx = round % keypairs.length;
  const kp = keypairs[idx];
  const label = channelLabel(idx);

  let account: StellarSdk.Account;
  try {
    account = await getNextAccountFor(kp);
  } catch (err) {
    seqCache.delete(kp.publicKey());
    throw new Error(`${label} getAccount failed: ${err instanceof Error ? err.message : err}`);
  }

  const contract = new StellarSdk.Contract(VERIFIER_CONTRACT_ID);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000", // 0.1 XLM cap — pairing check is expensive
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "push",
        StellarSdk.nativeToScVal(BigInt(round), { type: "u64" }),
        StellarSdk.xdr.ScVal.scvBytes(sigCompressed),
        StellarSdk.xdr.ScVal.scvBytes(sigUncompressed),
      )
    )
    .setTimeout(60)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (RpcNamespace.Api.isSimulationError(sim)) {
    seqCache.delete(kp.publicKey()); // reset on error
    throw new Error(`${label} simulation failed: ${sim.error}`);
  }

  const prepared = RpcNamespace.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  let response: Awaited<ReturnType<typeof rpc.sendTransaction>>;
  try {
    response = await rpc.sendTransaction(prepared);
  } catch (err) {
    seqCache.delete(kp.publicKey());
    throw new Error(`${label} sendTransaction threw: ${err instanceof Error ? err.message : err}`);
  }

  if (response.status === "ERROR") {
    seqCache.delete(kp.publicKey());
    const summary = JSON.stringify(response).slice(0, 200);
    throw new Error(`${label} sendTransaction ERROR: ${summary}`);
  }

  console.log(`[feeder] → ${label} round ${round} sent — tx ${response.hash.slice(0, 12)}…`);
  return response.hash;
}

/**
 * Query the verifier contract's latest() function (read-only simulation).
 * Returns { round, randomness } or null if no round verified yet.
 *
 * Uses channel A's pubkey as the simulation source — no fee involved, just
 * needs a valid funded account on the network.
 */
export async function getLatestVerifiedRound(): Promise<{
  round: number;
  randomness: string;
} | null> {
  try {
    const sourcePub = keypairs[0].publicKey();
    const account = await rpc.getAccount(sourcePub);
    const contract = new StellarSdk.Contract(VERIFIER_CONTRACT_ID);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("latest"))
      .setTimeout(30)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (RpcNamespace.Api.isSimulationError(simulation)) {
      return null;
    }

    const result = simulation.result?.retval;
    if (!result) return null;

    // Result is Option<(u64, BytesN<32>)> — None when no round verified yet.
    const native = StellarSdk.scValToNative(result);
    if (native == null || !Array.isArray(native) || native.length < 2) return null;

    return {
      round: Number(native[0]),
      randomness: Buffer.from(native[1]).toString("hex"),
    };
  } catch {
    return null;
  }
}
