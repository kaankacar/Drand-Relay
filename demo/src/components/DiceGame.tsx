import React, { useEffect, useRef, useState } from "react";
import {
  connectWallet,
  DICE_CONTRACT_ID,
  rpc,
  buildContractTx,
  signAndSubmit,
} from "../wallet.ts";
import { Contract, TransactionBuilder, Address, nativeToScVal, Networks, scValToNative, rpc as RpcNamespace } from "@stellar/stellar-sdk";

const FEEDER_URL        = import.meta.env.VITE_FEEDER_URL ?? "https://stellardrand.duckdns.org";
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const QUICKNET_GENESIS  = 1_692_803_367;
const QUICKNET_PERIOD   = 3;

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

// "ready"    = round is available, waiting for user to click Reveal
// "revealing"= reveal tx in flight
type Phase = "idle" | "rolling" | "waiting" | "ready" | "revealing" | "done";

interface CommitState { targetRound: number }

function truncateAddress(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }

function getCurrentDrandRound(): number {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - QUICKNET_GENESIS);
  return Math.floor(elapsed / QUICKNET_PERIOD) + 1;
}

/** Ask the feeder REST API if a round has been verified on-chain. */
async function isRoundOnChain(round: number): Promise<boolean> {
  try {
    const res = await fetch(`${FEEDER_URL}/random/${round}`);
    return res.ok;
  } catch {
    return false;
  }
}

export function DiceGame() {
  const [address, setAddress]     = useState<string | null>(null);
  const [phase, setPhase]         = useState<Phase>("idle");
  const [commit, setCommit]       = useState<CommitState | null>(null);
  const [result, setResult]       = useState<number | null>(null);
  const [history, setHistory]     = useState<number[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [currentRound, setCurrentRound] = useState(getCurrentDrandRound());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick current round every 3s
  useEffect(() => {
    const t = setInterval(() => setCurrentRound(getCurrentDrandRound()), 3000);
    return () => clearInterval(t);
  }, []);

  // Poll feeder until target round is on-chain
  useEffect(() => {
    if (phase !== "waiting" || !commit) return;

    pollRef.current = setInterval(async () => {
      const ready = await isRoundOnChain(commit.targetRound);
      if (ready) {
        clearInterval(pollRef.current!);
        setPhase("ready");
      }
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [phase, commit]);

  async function handleConnect() {
    setError(null);
    try { setAddress(await connectWallet()); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to connect"); }
  }

  async function handleRoll() {
    if (!address) return;
    setError(null);
    setPhase("rolling");
    try {
      const current     = getCurrentDrandRound();
      const targetRound = current + 20; // +20 absorbs TOCTOU & clock skew

      const xdr = await buildContractTx(
        DICE_CONTRACT_ID, "roll",
        [new Address(address).toScVal(), nativeToScVal(BigInt(targetRound), { type: "u64" })],
        address,
      );
      await signAndSubmit(xdr, address);

      setCommit({ targetRound });
      setPhase("waiting");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Roll failed");
      setPhase("idle");
    }
  }

  async function handleReveal() {
    if (!address) return;
    setError(null);
    setPhase("revealing");
    try {
      const xdr = await buildContractTx(
        DICE_CONTRACT_ID, "settle",
        [new Address(address).toScVal()],
        address,
      );
      await signAndSubmit(xdr, address);

      const newHistory = await fetchHistory(address);
      setHistory(newHistory);
      setResult(newHistory[newHistory.length - 1] ?? null);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reveal failed");
      setPhase("ready"); // let them retry
    }
  }

  async function fetchHistory(addr: string): Promise<number[]> {
    try {
      const account  = await rpc.getAccount(addr);
      const contract = new Contract(DICE_CONTRACT_ID);
      const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(contract.call("get_history", nativeToScVal(addr, { type: "address" })))
        .setTimeout(30).build();
      const sim = await rpc.simulateTransaction(tx);
      if (RpcNamespace.Api.isSimulationError(sim)) return [];
      const native = scValToNative(sim.result!.retval) as number[];
      return Array.isArray(native) ? native.map(Number) : [];
    } catch { return []; }
  }

  const remaining = commit ? Math.max(0, commit.targetRound - currentRound) : 0;

  return (
    <div className="bg-gray-900 rounded-2xl p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Roll the Dice</h2>
        <span className="text-xs text-gray-500 font-mono">round #{currentRound.toLocaleString()}</span>
      </div>

      {/* Not connected */}
      {!address && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">
            Connect your Stellar wallet. Your dice result will be determined by a future drand round
            that doesn't exist yet — provably fair, verifiable on-chain.
          </p>
          <button onClick={handleConnect}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium text-white transition-colors">
            Connect Wallet
          </button>
        </div>
      )}

      {/* Connected */}
      {address && (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-gray-800 rounded-xl px-3 py-2">
            <span className="text-xs text-gray-500">Connected</span>
            <span className="font-mono text-sm text-gray-200">{truncateAddress(address)}</span>
          </div>

          {phase === "idle" && (
            <button onClick={handleRoll}
              className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-500 rounded-xl font-medium text-white transition-colors">
              🎲 Roll Dice
            </button>
          )}

          {phase === "rolling" && (
            <div className="text-center py-4 text-gray-400 animate-pulse text-sm">Submitting roll…</div>
          )}

          {phase === "waiting" && commit && (
            <div className="space-y-3">
              <div className="bg-gray-800 rounded-xl p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Committed to round</span>
                  <span className="font-mono text-white">{commit.targetRound.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Current round</span>
                  <span className="font-mono text-gray-300">{currentRound.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Estimated wait</span>
                  <span className="font-mono text-yellow-400">~{remaining * 3}s</span>
                </div>
              </div>
              <div className="text-center text-xs text-gray-500 animate-pulse">
                Waiting for round {commit.targetRound} to be verified on-chain…
              </div>
            </div>
          )}

          {phase === "ready" && commit && (
            <div className="space-y-3">
              <div className="bg-green-950 border border-green-800 rounded-xl p-3 text-sm text-green-300">
                Round {commit.targetRound.toLocaleString()} is on-chain. Reveal your result.
              </div>
              <button onClick={handleReveal}
                className="w-full py-2.5 px-4 bg-yellow-500 hover:bg-yellow-400 rounded-xl font-medium text-gray-900 transition-colors">
                Reveal Result
              </button>
            </div>
          )}

          {phase === "revealing" && (
            <div className="text-center py-4 text-gray-400 animate-pulse text-sm">Revealing…</div>
          )}

          {phase === "done" && result !== null && (
            <div className="space-y-4">
              <div className="text-center">
                <div className="text-8xl">{DICE_FACES[result - 1]}</div>
                <div className="mt-2 text-2xl font-bold text-white">You rolled a {result}!</div>
              </div>
              <button onClick={() => { setPhase("idle"); setResult(null); setCommit(null); }}
                className="w-full py-2.5 px-4 bg-gray-700 hover:bg-gray-600 rounded-xl font-medium text-white transition-colors">
                Roll Again
              </button>
            </div>
          )}

          {history.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs text-gray-500">Recent rolls</span>
              <div className="flex gap-2 flex-wrap">
                {history.slice(-5).map((r, i) => (
                  <span key={i} className="text-2xl" title={`Rolled ${r}`}>{DICE_FACES[r - 1]}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl p-3 text-sm text-red-300">{error}</div>
      )}
    </div>
  );
}
