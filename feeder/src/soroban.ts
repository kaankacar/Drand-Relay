/**
 * soroban.ts — submit push(round, sig_compressed, sig_uncompressed) to the
 * drand verifier contract via OpenZeppelin Relayer's HTTP API.
 *
 * Why OZ Relayer:
 *   Stellar caps each source account at one tx per ledger (Soroban-era rule
 *   covering both classic and Soroban tx submission). drand publishes a round
 *   every 3s; with ~5s ledger close a single signer only lands 60% of rounds.
 *   The fix is the channel-accounts pattern: rotate across multiple signers.
 *   OZ Relayer hosts those signers, manages their sequence numbers, and
 *   exposes them via a single HTTP API. We round-robin `round % N` here.
 *
 * Signature encoding:
 *   drand API returns 48-byte compressed G1 (96 hex chars). The contract
 *   expects both:
 *     - the 48-byte compressed sig as published (on-chain randomness =
 *       sha256(compressed) matches drand's `randomness` field byte-for-byte)
 *     - a 96-byte uncompressed sig (X||Y, no flag bits) for the BLS pairing
 *       check (Soroban's host BLS API takes uncompressed input).
 *   The contract verifies both encode the same point before storing anything.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc as RpcNamespace } from "@stellar/stellar-sdk";
import { bls12_381 as bls } from "@noble/curves/bls12-381.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const VERIFIER_CONTRACT_ID = process.env.VERIFIER_CONTRACT_ID ?? "";
const OZ_RELAYER_URL = process.env.OZ_RELAYER_URL ?? "http://oz-relayer:8080";
const OZ_RELAYER_API_KEY = process.env.OZ_RELAYER_API_KEY ?? "";
const OZ_RELAYER_IDS = (process.env.OZ_RELAYER_IDS ?? "relayer-a,relayer-b,relayer-c")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const READONLY_SOURCE_PUBKEY = process.env.READONLY_SOURCE_PUBKEY ?? "";

if (!VERIFIER_CONTRACT_ID) throw new Error("VERIFIER_CONTRACT_ID not set");
if (!OZ_RELAYER_API_KEY) throw new Error("OZ_RELAYER_API_KEY not set");
if (OZ_RELAYER_IDS.length === 0) throw new Error("OZ_RELAYER_IDS is empty");
if (!READONLY_SOURCE_PUBKEY) throw new Error("READONLY_SOURCE_PUBKEY not set");

export const rpc = new RpcNamespace.Server(RPC_URL);

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
 * Submit a drand beacon to the verifier contract's push() function via OZ Relayer.
 *
 * @param round    - drand round number (used for both the contract call and round-robin signer selection)
 * @param sigHex   - hex-encoded BLS G1 signature from API (96 hex chars = 48 bytes compressed)
 * @returns OZ Relayer job ID on success
 */
export async function pushBeacon(round: number, sigHex: string): Promise<string> {
  const sigCompressed = Buffer.from(sigHex, "hex");
  if (sigCompressed.length !== 48) {
    throw new Error(`compressed sig must be 48 bytes, got ${sigCompressed.length}`);
  }
  const sigUncompressed = decompressG1(sigHex);

  // Round-robin signer selection across configured relayers.
  const relayerId = OZ_RELAYER_IDS[round % OZ_RELAYER_IDS.length];

  const body = {
    network: "testnet",
    operations: [
      {
        type: "invoke_contract",
        contract_address: VERIFIER_CONTRACT_ID,
        function_name: "push",
        args: [
          { u64: String(round) },
          { bytes: sigCompressed.toString("hex") },
          { bytes: sigUncompressed.toString("hex") },
        ],
        auth: { type: "source_account" },
      },
    ],
  };

  const res = await fetch(`${OZ_RELAYER_URL}/api/v1/relayers/${relayerId}/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OZ_RELAYER_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OZ Relayer ${relayerId} returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => ({}))) as { id?: string };
  const jobId = json.id ?? "(no-id)";
  console.log(`[feeder] → ${relayerId} queued round ${round} (job ${jobId.slice(0, 12)}…)`);
  return jobId;
}

/**
 * Query the verifier contract's latest() function (read-only simulation).
 * Returns { round, randomness } or null if no round verified yet.
 *
 * Does NOT go through OZ Relayer — the Soroban RPC's simulateTransaction is
 * a free read with no fee or rate concern, no need to involve a signer.
 */
export async function getLatestVerifiedRound(): Promise<{
  round: number;
  randomness: string;
} | null> {
  try {
    const account = await rpc.getAccount(READONLY_SOURCE_PUBKEY);
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

    const round = Number(native[0]);
    const randomness = Buffer.from(native[1]).toString("hex");

    return { round, randomness };
  } catch {
    return null;
  }
}
