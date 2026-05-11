/**
 * wallet.ts — StellarWalletsKit v2 integration.
 *
 * v2 API changes from v1:
 *   - Install via JSR: npx jsr add @creit-tech/stellar-wallets-kit
 *   - StellarWalletsKit.init({ modules: defaultModules() })
 *   - authModal() replaces openModal() and returns the address directly
 *   - signTransaction() takes { networkPassphrase, address }
 *
 * After installing deps run:
 *   cd demo && npx jsr add @creit-tech/stellar-wallets-kit
 */

import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit-tech/stellar-wallets-kit/modules/utils";
import { Networks, rpc as RpcNamespace, TransactionBuilder, Contract, xdr } from "@stellar/stellar-sdk";

const RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE ?? Networks.TESTNET;

// Defaults point at the canonical testnet deployment so the demo works
// out of the box even when no .env file is present (e.g., on GitHub Pages).
export const VERIFIER_CONTRACT_ID =
  import.meta.env.VITE_VERIFIER_CONTRACT_ID ??
  "CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM";
export const DICE_CONTRACT_ID =
  import.meta.env.VITE_DICE_CONTRACT_ID ??
  "CCBHSZD3AR6DQMPXBUAT5RELARIMFPZEN6ZLC3SIHU6UQOLUCB35LYUI";

export const rpc = new RpcNamespace.Server(RPC_URL);

// Initialize once at module load
StellarWalletsKit.init({ modules: defaultModules() });

/** Open the wallet selection modal and return the connected address. */
export async function connectWallet(): Promise<string> {
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

/** Get the currently connected address (throws if not connected). */
export async function getAddress(): Promise<string> {
  const { address } = await StellarWalletsKit.getAddress();
  return address;
}

/**
 * Sign a transaction XDR string with the connected wallet and submit it.
 * Returns the tx hash.
 */
export async function signAndSubmit(xdr: string, address: string): Promise<string> {
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });

  const response = await rpc.sendTransaction(
    TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE)
  );

  if (response.status === "ERROR") {
    throw new Error(`Transaction failed: ${JSON.stringify(response)}`);
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
      throw new Error(`Transaction failed: ${hash}`);
    }
  }
  throw new Error(`Transaction timeout: ${hash}`);
}

/**
 * Build, simulate, and return the prepared XDR for a contract call.
 * Callers must pass pre-built xdr.ScVal[] to ensure correct types.
 * Call signAndSubmit() with the result.
 */
export async function buildContractTx(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourceAddress: string
): Promise<string> {
  const account = await rpc.getAccount(sourceAddress);
  const contract = new Contract(contractId);

  // rpc.getAccount() returns a StellarSdk.Account — use it directly
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await rpc.simulateTransaction(tx);
  if (RpcNamespace.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  return RpcNamespace.assembleTransaction(tx, simulation).build().toXDR();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
