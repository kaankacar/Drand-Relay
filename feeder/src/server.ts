/**
 * server.ts — Express REST API exposing drand randomness from the verifier contract.
 *
 * GET /random          → latest verified round from on-chain
 * GET /random/:round   → specific round (if verified on-chain)
 * GET /health          → liveness check
 */

import express, { Request, Response } from "express";
import cors from "cors";
import { roundToTimestamp } from "./drand.js";
import { getLatestVerifiedRound, rpc, READONLY_SOURCE_PUBKEY } from "./soroban.js";
import * as StellarSdk from "@stellar/stellar-sdk";
import { rpc as RpcNamespace } from "@stellar/stellar-sdk";

const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const VERIFIER_CONTRACT_ID = process.env.VERIFIER_CONTRACT_ID ?? "";

export interface BeaconEntry {
  round: number;
  randomness: string;
  timestamp: string;
}

export function createApp(getFeed?: () => BeaconEntry[]): express.Application {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // --------------------------------------------------------------------------
  // GET /health
  // --------------------------------------------------------------------------
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // --------------------------------------------------------------------------
  // GET /feed — last N verified rounds (newest first), for beacon explorer view
  // --------------------------------------------------------------------------
  app.get("/feed", (_req: Request, res: Response) => {
    if (!getFeed) {
      res.status(503).json({ error: "Feed not available" });
      return;
    }
    res.json(getFeed());
  });

  // --------------------------------------------------------------------------
  // GET /random — latest verified round
  // --------------------------------------------------------------------------
  app.get("/random", async (_req: Request, res: Response) => {
    try {
      const latest = await getLatestVerifiedRound();
      if (!latest) {
        res.status(503).json({ error: "No round verified yet" });
        return;
      }
      res.json({
        round: latest.round,
        randomness: "0x" + latest.randomness,
        timestamp: new Date(roundToTimestamp(latest.round) * 1000).toISOString(),
      });
    } catch (err) {
      console.error("[server] GET /random error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --------------------------------------------------------------------------
  // GET /random/:round — specific round
  // --------------------------------------------------------------------------
  app.get("/random/:round", async (req: Request, res: Response) => {
    const round = parseInt(req.params.round, 10);
    if (isNaN(round) || round <= 0) {
      res.status(400).json({ error: "Invalid round number" });
      return;
    }

    try {
      const randomness = await queryRoundFromContract(round);
      if (!randomness) {
        res.status(404).json({ error: `Round ${round} not verified on-chain` });
        return;
      }
      res.json({
        round,
        randomness: "0x" + randomness,
        timestamp: new Date(roundToTimestamp(round) * 1000).toISOString(),
      });
    } catch (err) {
      console.error(`[server] GET /random/${round} error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}

/** Query verifier.get(round) via simulation (read-only, no fee). */
async function queryRoundFromContract(round: number): Promise<string | null> {
  try {
    const account = await rpc.getAccount(READONLY_SOURCE_PUBKEY).catch(() => null);
    if (!account) return null;

    const contract = new StellarSdk.Contract(VERIFIER_CONTRACT_ID);
    // account is already a StellarSdk.Account — use it directly
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("get", StellarSdk.nativeToScVal(BigInt(round), { type: "u64" }))
      )
      .setTimeout(30)
      .build();

    const sim = await rpc.simulateTransaction(tx);
    if (RpcNamespace.Api.isSimulationError(sim)) return null;

    const result = sim.result?.retval;
    if (!result) return null;

    // Result is Option<BytesN<32>>: scvVoid = None, scvBytes = Some
    const native = StellarSdk.scValToNative(result);
    if (native === undefined || native === null) return null;
    return Buffer.from(native as Uint8Array).toString("hex");
  } catch {
    return null;
  }
}
