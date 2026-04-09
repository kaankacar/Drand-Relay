/**
 * index.ts — drand feeder with a bounded push queue.
 *
 * Stellar requires sequential tx sequence numbers, so we can't submit
 * multiple transactions in parallel. Instead:
 *   - Poll loop: enqueues every new drand round (max queue depth: 5)
 *   - Push worker: drains queue one tx at a time, fast as Stellar allows
 *   - REST server: serves data from the in-memory confirmed feed
 *
 * The push worker submits + confirms each tx sequentially. Stellar testnet
 * confirms in ~5-8s. drand produces a round every 3s. The queue absorbs
 * the backlog so every round eventually gets pushed (within ~15s).
 */

import "dotenv/config";
import { fetchLatest, roundToTimestamp } from "./drand.js";
import { pushBeacon, getLatestVerifiedRound } from "./soroban.js";
import { createApp, BeaconEntry } from "./server.js";

const PORT            = parseInt(process.env.PORT ?? "3001", 10);
const POLL_MS         = 3_000;
const MAX_FEED_SIZE   = 50;
const MAX_QUEUE_DEPTH = 5; // don't let the queue grow indefinitely

// ---------------------------------------------------------------------------
// In-memory beacon feed (newest first, confirmed on-chain)
// ---------------------------------------------------------------------------

const recentBeacons: BeaconEntry[] = [];

function addToFeed(entry: BeaconEntry): void {
  if (recentBeacons.some((e) => e.round === entry.round)) return;
  recentBeacons.unshift(entry);
  recentBeacons.sort((a, b) => b.round - a.round);
  if (recentBeacons.length > MAX_FEED_SIZE) recentBeacons.pop();
}

// ---------------------------------------------------------------------------
// Push queue
// ---------------------------------------------------------------------------

interface PendingRound {
  round: number;
  sigHex: string;
  randomness: string;
}

const queue: PendingRound[] = [];
let workerBusy = false;

function enqueue(item: PendingRound): void {
  if (queue.some((q) => q.round === item.round)) return; // deduplicate
  if (queue.length >= MAX_QUEUE_DEPTH) {
    // Drop oldest — we only care about recent rounds
    queue.shift();
  }
  queue.push(item);
  runWorker(); // kick the worker if idle
}

async function runWorker(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;

  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      const txHash = await pushBeacon(item.round, item.sigHex);
      addToFeed({
        round: item.round,
        randomness: "0x" + item.randomness,
        timestamp: new Date(roundToTimestamp(item.round) * 1000).toISOString(),
      });
      console.log(`[feeder] ✓ round ${item.round} confirmed — tx ${txHash.slice(0, 12)}…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[feeder] ✗ round ${item.round}:`, msg.slice(0, 100));
    }
  }

  workerBusy = false;
}

// ---------------------------------------------------------------------------
// Poll loop — runs every 3s, enqueues new rounds
// ---------------------------------------------------------------------------

async function runFeeder(): Promise<void> {
  console.log("[feeder] starting drand quicknet feeder");

  const existing = await getLatestVerifiedRound();
  let lastEnqueuedRound = existing?.round ?? 0;
  if (lastEnqueuedRound > 0) {
    console.log(`[feeder] resuming — latest on-chain round: ${lastEnqueuedRound}`);
    addToFeed({
      round: lastEnqueuedRound,
      randomness: "0x" + existing!.randomness,
      timestamp: new Date(roundToTimestamp(lastEnqueuedRound) * 1000).toISOString(),
    });
  }

  while (true) {
    try {
      const beacon = await fetchLatest();
      if (beacon.round > lastEnqueuedRound) {
        lastEnqueuedRound = beacon.round;
        console.log(`[feeder] queuing round ${beacon.round}`);
        enqueue({ round: beacon.round, sigHex: beacon.signature, randomness: beacon.randomness });
      }
    } catch (err) {
      console.error("[feeder] fetch error:", err instanceof Error ? err.message : err);
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// REST server + main
// ---------------------------------------------------------------------------

function startServer(): void {
  const app = createApp(() => [...recentBeacons]);
  app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

startServer();
runFeeder().catch((err) => {
  console.error("[feeder] fatal:", err);
  process.exit(1);
});
