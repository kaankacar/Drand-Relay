/**
 * soroban.ts — build and submit push(round, sig) transactions to the
 * drand verifier contract on Stellar testnet.
 *
 * Key patterns:
 *   - Always simulate before submit (assembleTransaction adds resource limits)
 *   - Track sequence number in memory; reload on tx_bad_seq
 *   - Retry once on sequence errors before giving up
 *
 * Signature decompression:
 *   drand API returns 48-byte compressed G1 (96 hex chars).
 *   Soroban contract expects 96-byte uncompressed G1 (192 hex chars: X||Y).
 *   We decompress here before building the transaction.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc as RpcNamespace } from "@stellar/stellar-sdk";
import { bls12_381 as bls } from "@noble/curves/bls12-381.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const VERIFIER_CONTRACT_ID = process.env.VERIFIER_CONTRACT_ID ?? "";
const FEEDER_SECRET_KEY = process.env.FEEDER_SECRET_KEY ?? "";

if (!VERIFIER_CONTRACT_ID) throw new Error("VERIFIER_CONTRACT_ID not set");
if (!FEEDER_SECRET_KEY) throw new Error("FEEDER_SECRET_KEY not set");

export const rpc = new RpcNamespace.Server(RPC_URL);
export const keypair = StellarSdk.Keypair.fromSecret(FEEDER_SECRET_KEY);

/** Cached sequence number to avoid reloading the account on every tx. */
let cachedSequence: bigint | null = null;

async function getAccount(): Promise<StellarSdk.Account> {
  const account = await rpc.getAccount(keypair.publicKey());
  cachedSequence = BigInt(account.sequenceNumber());
  return account;
}

async function getNextSequenceAccount(): Promise<StellarSdk.Account> {
  if (cachedSequence === null) {
    return getAccount();
  }
  cachedSequence++;
  return new StellarSdk.Account(keypair.publicKey(), cachedSequence.toString());
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
 * @param round    - drand round number
 * @param sigHex   - hex-encoded BLS G1 signature from API (96 hex chars = 48 bytes compressed)
 * @returns tx hash on success
 */
export async function pushBeacon(round: number, sigHex: string): Promise<string> {
  // Decompress: 48-byte compressed G1 → 96-byte uncompressed (Soroban format)
  const sigBuffer = decompressG1(sigHex);

  const account = await getNextSequenceAccount();

  // Build the transaction
  const contract = new StellarSdk.Contract(VERIFIER_CONTRACT_ID);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000", // 0.1 XLM max fee — pairing check is expensive
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "push",
        StellarSdk.nativeToScVal(BigInt(round), { type: "u64" }),
        StellarSdk.xdr.ScVal.scvBytes(sigBuffer),
      )
    )
    .setTimeout(30)
    .build();

  // Simulate to get resource limits
  const simulation = await rpc.simulateTransaction(tx);
  if (RpcNamespace.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // Assemble (adds soroban resource envelope)
  const prepared = RpcNamespace.assembleTransaction(tx, simulation).build();
  prepared.sign(keypair);

  // Submit
  try {
    const response = await rpc.sendTransaction(prepared);
    if (response.status === "ERROR") {
      throw new Error(`sendTransaction error: ${JSON.stringify(response)}`);
    }

    // Poll for confirmation
    const hash = response.hash;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const status = await rpc.getTransaction(hash);
      if (status.status === RpcNamespace.Api.GetTransactionStatus.SUCCESS) {
        return hash;
      }
      if (status.status === RpcNamespace.Api.GetTransactionStatus.FAILED) {
        cachedSequence = null; // reset on failure
        throw new Error(`Transaction failed: ${hash}`);
      }
    }
    throw new Error(`Transaction timeout: ${hash}`);
  } catch (err: unknown) {
    // On sequence error, reload and retry once
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("tx_bad_seq")) {
      console.warn("[soroban] sequence error, reloading account and retrying");
      cachedSequence = null;
      return pushBeacon(round, sigHex);
    }
    throw err;
  }
}

/**
 * Query the verifier contract's latest() function.
 * Returns { round, randomness } or null if no round verified yet.
 */
export async function getLatestVerifiedRound(): Promise<{
  round: number;
  randomness: string;
} | null> {
  try {
    // rpc.getAccount() returns a StellarSdk.Account — use it directly
    const account = await rpc.getAccount(keypair.publicKey());
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
      return null; // contract panics if no round yet
    }

    const result = simulation.result?.retval;
    if (!result) return null;

    // Result is a tuple (u64, BytesN<32>) — use scValToNative for safe parsing
    const native = StellarSdk.scValToNative(result) as [bigint, Buffer];
    if (!Array.isArray(native) || native.length < 2) return null;

    const round = Number(native[0]);
    const randomness = Buffer.from(native[1]).toString("hex");

    return { round, randomness };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
