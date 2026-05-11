import React, { useState } from "react";
import { RandomFetcher } from "./components/RandomFetcher.tsx";
import { DiceGame } from "./components/DiceGame.tsx";
import { BeaconFeed } from "./components/BeaconFeed.tsx";
import { HowItWorks } from "./components/HowItWorks.tsx";

type Tab = "random" | "dice" | "feed" | "how";

const TABS: { id: Tab; label: string }[] = [
  { id: "random", label: "Randomness" },
  { id: "dice",   label: "Dice Game" },
  { id: "feed",   label: "Beacon Feed" },
  { id: "how",    label: "How It Works" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("random");

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Beacon</h1>
            <p className="text-xs text-gray-500">
              drand randomness oracle on Stellar · BLS12-381 on-chain verification
            </p>
          </div>
          <a
            href="https://developers.stellar.org/docs/build/apps/zk"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            ZK on Stellar ↗
          </a>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-gray-800">
        <div className="max-w-2xl mx-auto px-6">
          <nav className="flex gap-1 -mb-px">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`
                  px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap
                  ${tab === t.id
                    ? "border-violet-500 text-violet-400"
                    : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600"
                  }
                `}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Main */}
      <main className="max-w-2xl mx-auto px-6 py-8">
        {tab === "random" && <RandomFetcher />}
        {tab === "dice"   && <DiceGame />}
        {tab === "feed"   && <BeaconFeed />}
        {tab === "how"    && <HowItWorks />}

        <p className="text-xs text-gray-600 text-center pb-4 mt-8">
          Randomness is verified on-chain using BLS12-381 pairing check (CAP-0059, Protocol 22+).
          Dice results are determined by a future drand round — the outcome is unknown when you commit.
        </p>
      </main>
    </div>
  );
}
