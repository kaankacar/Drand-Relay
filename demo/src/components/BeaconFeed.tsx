/**
 * BeaconFeed.tsx — Section C: live drand beacon chain explorer.
 *
 * Shows the last N rounds pushed on-chain by the feeder as a chain-like
 * transaction list. Auto-refreshes every 3 seconds.
 */

import React, { useEffect, useState, useRef } from "react";

const FEEDER_URL = import.meta.env.VITE_FEEDER_URL ?? "https://stellardrand.duckdns.org";

interface BeaconEntry {
  round: number;
  randomness: string; // "0x..."
  timestamp: string;  // ISO string
}

function shortHex(hex: string): string {
  const h = hex.replace(/^0x/, "");
  return `0x${h.slice(0, 8)}…${h.slice(-6)}`;
}

function timeAgo(isoString: string): string {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function BeaconFeed() {
  const [entries, setEntries] = useState<BeaconEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newRound, setNewRound] = useState<number | null>(null);
  const prevTopRef = useRef<number | null>(null);
  const [, setTick] = useState(0); // force re-render for timeAgo

  async function fetchFeed() {
    try {
      const res = await fetch(`${FEEDER_URL}/feed`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data: BeaconEntry[] = await res.json();
      setEntries(data);
      setError(null);

      // Highlight newly added round
      if (data.length > 0 && prevTopRef.current !== null && data[0].round !== prevTopRef.current) {
        setNewRound(data[0].round);
        setTimeout(() => setNewRound(null), 1500);
      }
      if (data.length > 0) prevTopRef.current = data[0].round;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  // Auto-refresh every 3s
  useEffect(() => {
    fetchFeed();
    const poll = setInterval(fetchFeed, 3000);
    return () => clearInterval(poll);
  }, []);

  // Re-render every second so timeAgo stays fresh
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="bg-gray-900 rounded-2xl p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Beacon Feed</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Live on-chain drand rounds · auto-updates every 3s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${error ? "bg-red-500" : "bg-green-500 animate-pulse"}`} />
          <span className="text-xs text-gray-500 font-mono">
            {entries.length > 0 ? `#${entries[0].round.toLocaleString()}` : "—"}
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && entries.length === 0 && (
        <div className="text-center py-8 text-gray-500 animate-pulse text-sm">
          Connecting to feeder…
        </div>
      )}

      {/* Chain list */}
      {entries.length > 0 && (
        <div className="space-y-1 max-h-[480px] overflow-y-auto pr-1 scrollbar-thin">
          {entries.map((entry, idx) => {
            const isNew = entry.round === newRound;
            const isLatest = idx === 0;
            return (
              <div
                key={entry.round}
                className={`
                  relative flex items-stretch gap-3 rounded-xl px-4 py-3
                  transition-all duration-500
                  ${isNew ? "bg-violet-950 border border-violet-700" : "bg-gray-800 border border-transparent"}
                  hover:border-gray-600
                `}
              >
                {/* Chain connector */}
                {idx < entries.length - 1 && (
                  <div className="absolute left-6 top-full w-px h-1 bg-gray-700 z-10" />
                )}

                {/* Left: round badge */}
                <div className="flex flex-col items-center justify-center min-w-[56px]">
                  <span className={`text-xs font-bold font-mono ${isLatest ? "text-violet-400" : "text-gray-400"}`}>
                    #{entry.round.toLocaleString()}
                  </span>
                  {isLatest && (
                    <span className="text-[10px] text-violet-500 mt-0.5">latest</span>
                  )}
                </div>

                {/* Divider */}
                <div className="w-px bg-gray-700 self-stretch" />

                {/* Right: randomness + time */}
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="font-mono text-sm text-gray-200 truncate">
                    {shortHex(entry.randomness)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(entry.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                    {" · "}
                    <span className="text-gray-600">{timeAgo(entry.timestamp)}</span>
                  </div>
                </div>

                {/* Copy button */}
                <button
                  onClick={() => navigator.clipboard?.writeText(entry.randomness)}
                  className="self-center text-gray-600 hover:text-gray-300 transition-colors text-xs px-1 shrink-0"
                  title="Copy randomness"
                >
                  ⎘
                </button>
              </div>
            );
          })}
        </div>
      )}

      {entries.length === 0 && !loading && !error && (
        <div className="text-center py-8 text-gray-500 text-sm">
          No beacons yet — feeder may be starting up.
        </div>
      )}
    </div>
  );
}
