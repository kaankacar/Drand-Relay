/**
 * RandomFetcher.tsx — Section A: fetch and display latest drand randomness.
 *
 * No wallet needed. Hits the feeder REST API (GET /random).
 * Each click fetches a fresh round — since quicknet updates every 3s,
 * repeated clicks will show new rounds while the feeder is running.
 */

import React, { useState } from "react";

const FEEDER_URL = import.meta.env.VITE_FEEDER_URL ?? "https://stellardrand.duckdns.org";

interface RandomData {
  round: number;
  randomness: string;
  timestamp: string;
}

/** Render randomness hex as colored blocks for visual appeal. */
function ColoredHex({ hex }: { hex: string }) {
  const clean = hex.replace(/^0x/, "");
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += 8) {
    chunks.push(clean.slice(i, i + 8));
  }

  const colors = [
    "text-violet-400", "text-blue-400", "text-cyan-400", "text-teal-400",
    "text-green-400", "text-yellow-400", "text-orange-400", "text-red-400",
  ];

  return (
    <span className="font-mono text-sm break-all">
      {chunks.map((chunk, i) => (
        <span key={i} className={colors[i % colors.length]}>
          {chunk}{" "}
        </span>
      ))}
    </span>
  );
}

export function RandomFetcher() {
  const [data, setData] = useState<RandomData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchRandom() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${FEEDER_URL}/random`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-900 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Verified Randomness</h2>
        <span className="text-xs text-gray-500 font-mono">drand quicknet · 3s</span>
      </div>

      <p className="text-sm text-gray-400">
        Fetches the latest round verified on-chain by the Soroban BLS12-381 verifier.
        No wallet required.
      </p>

      <button
        onClick={fetchRandom}
        disabled={loading}
        className="w-full py-2.5 px-4 bg-violet-600 hover:bg-violet-500 disabled:bg-violet-800
                   disabled:cursor-not-allowed rounded-xl font-medium text-white transition-colors"
      >
        {loading ? "Fetching…" : "Fetch Random"}
      </button>

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {data && (
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Round</span>
            <span className="font-mono text-white">{data.round.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Timestamp</span>
            <span className="font-mono text-gray-300">{new Date(data.timestamp).toLocaleTimeString()}</span>
          </div>
          <div className="space-y-1">
            <span className="text-sm text-gray-500">Randomness</span>
            <div className="bg-gray-800 rounded-xl p-3">
              <ColoredHex hex={data.randomness} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
