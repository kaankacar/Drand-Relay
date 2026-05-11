# Drand-Relay demo

A small React SPA that exercises every public surface of the canonical
deployment, so you can see the relay working without writing any code.

**Live at https://kaankacar.github.io/Drand-Relay/** — auto-deploys from
`main` via `.github/workflows/deploy-demo.yml`.

## What's in it

| Tab | What it does |
|-----|--------------|
| **Randomness** | Hits `GET /random` on the canonical feeder and displays the latest verified round + 32-byte randomness. No wallet needed. |
| **Dice Game** | Full commit/reveal flow against the canonical dice-game contract. Connects a Stellar wallet (Freighter, xBull, etc.) via StellarWalletsKit, calls `roll(target_round)`, waits for the feeder to push that round, then `settle()` reveals the result. |
| **Beacon Feed** | Live list of the last 50 rounds the feeder has pushed. Polls `GET /feed` every 3 seconds. |
| **How It Works** | Plain-language walkthrough of the BLS pairing check, the compressed/uncompressed binding, and the commit/reveal pattern. |

Everything points at the canonical testnet endpoint by default
(`https://stellardrand.duckdns.org` + `CAESC7SC…F7QM`), so you can clone, install, run, and immediately see real on-chain randomness.

## Run locally

```bash
cd demo
npm install
cp .env.example .env   # already pre-filled with canonical addresses
npm run dev
```

Opens at `http://localhost:5173`. The dice tab needs a testnet wallet with
some XLM (use [Freighter](https://www.freighter.app) and friendbot to fund
it).

## Point it at your own deployment

If you've deployed your own verifier + feeder (per the operator guide in
[`../docs/RUNBOOK.md`](../docs/RUNBOOK.md) or [`../docs/MAINNET.md`](../docs/MAINNET.md)), edit `.env`:

```
VITE_FEEDER_URL=https://your-feeder.example.com
VITE_VERIFIER_CONTRACT_ID=C...your-verifier
VITE_DICE_CONTRACT_ID=C...your-dice
```

That's it — no code changes needed.

## Build for hosting

```bash
npm run build
```

Outputs a static bundle to `dist/`. Drop it on Vercel, Netlify, Cloudflare
Pages, GitHub Pages, or any static host. The bundle is ~600KB gzipped.
