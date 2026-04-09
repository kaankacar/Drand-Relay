/**
 * drand.ts — fetch beacons from the drand quicknet HTTP API.
 *
 * Chain: 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
 * Scheme: bls-unchained-g1-rfc9380 (truly unchained, 3-second period)
 * Signature: G1 (48 bytes = 96 hex chars)
 * Public key: G2 (96 bytes)
 */

export const CHAIN_HASH =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

export const QUICKNET_GENESIS = 1_692_803_367; // Unix timestamp of round 1
export const QUICKNET_PERIOD = 3;              // seconds per round

const BASE = `https://api.drand.sh/${CHAIN_HASH}`;

export interface DrandBeacon {
  round: number;
  /** sha256 of the signature — we re-derive this ourselves, don't trust it */
  randomness: string;
  /** BLS G1 signature, 48 bytes = 96 hex chars */
  signature: string;
}

export async function fetchLatest(): Promise<DrandBeacon> {
  const res = await fetch(`${BASE}/public/latest`);
  if (!res.ok) {
    throw new Error(`drand fetchLatest failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<DrandBeacon>;
}

export async function fetchRound(round: number): Promise<DrandBeacon> {
  const res = await fetch(`${BASE}/public/${round}`);
  if (!res.ok) {
    throw new Error(
      `drand fetchRound(${round}) failed: ${res.status} ${res.statusText}`
    );
  }
  return res.json() as Promise<DrandBeacon>;
}

/** Compute the Unix timestamp for a given quicknet round number. */
export function roundToTimestamp(round: number): number {
  return QUICKNET_GENESIS + (round - 1) * QUICKNET_PERIOD;
}
