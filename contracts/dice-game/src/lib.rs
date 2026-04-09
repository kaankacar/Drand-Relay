#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    symbol_short, Address, BytesN, Env, Vec,
};

// Cross-contract client for the drand verifier
use drand_verifier::DrandVerifierClient;

/// Quicknet period in seconds. Used to estimate future round numbers.
const QUICKNET_PERIOD_SECS: u64 = 3;
/// Quicknet genesis Unix timestamp.
const QUICKNET_GENESIS: u64 = 1_692_803_367;
/// Minimum number of rounds in the future a commit must target.
/// 10 rounds × 3s = 30s buffer ensures the feeder has time to push the round.
const FUTURE_ROUND_BUFFER: u64 = 10;

const MIN_TTL: u32 = 17_280;
const EXTEND_TO: u32 = 518_400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct Commitment {
    pub drand_round: u64,
    pub settled: bool,
}

#[contracttype]
pub enum DataKey {
    /// Instance storage: address of the drand verifier contract.
    Verifier,
    /// Persistent storage: pending/settled commitment per player.
    Commitment(Address),
    /// Persistent storage: Vec<u32> of last ≤10 dice results per player.
    History(Address),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DiceGame;

#[contractimpl]
impl DiceGame {
    /// Deploy-time constructor: record the verifier contract address.
    /// Usage: stellar contract deploy ... -- --verifier <C...>
    pub fn __constructor(env: Env, verifier: Address) {
        env.storage()
            .instance()
            .set(&DataKey::Verifier, &verifier);
        env.storage().instance().extend_ttl(MIN_TTL, EXTEND_TO);
    }

    // -----------------------------------------------------------------------
    // Phase 1 — commit
    // -----------------------------------------------------------------------

    /// Commit to a future drand round.
    ///
    /// `target_round` must be at least `FUTURE_ROUND_BUFFER` rounds ahead of
    /// the current estimated round (derived from ledger timestamp + quicknet
    /// genesis). This gives the off-chain feeder time to push the round before
    /// `settle()` is called.
    ///
    /// Overwrites any previous unsettled commitment for this player.
    pub fn roll(env: Env, player: Address, target_round: u64) {
        player.require_auth();

        // Estimate current drand round from ledger timestamp.
        // Formula: floor((now - genesis) / period) + 1
        let now = env.ledger().timestamp();
        let elapsed = now.saturating_sub(QUICKNET_GENESIS);
        let current_round = elapsed / QUICKNET_PERIOD_SECS + 1;
        let min_round = current_round + FUTURE_ROUND_BUFFER;

        assert!(
            target_round >= min_round,
            "target_round must be at least {} rounds in the future",
            FUTURE_ROUND_BUFFER
        );

        let commitment = Commitment {
            drand_round: target_round,
            settled: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(player.clone()), &commitment);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Commitment(player), MIN_TTL, EXTEND_TO);
    }

    // -----------------------------------------------------------------------
    // Phase 2 — reveal
    // -----------------------------------------------------------------------

    /// Settle a pending roll once the committed drand round is available.
    ///
    /// Anyone may call this on behalf of a player (useful for automation).
    /// Panics if:
    ///   - No commitment exists for this player
    ///   - The commitment is already settled
    ///   - The committed round is not yet in the verifier contract
    pub fn settle(env: Env, player: Address) {
        let commitment: Commitment = env
            .storage()
            .persistent()
            .get(&DataKey::Commitment(player.clone()))
            .expect("no commitment found for player");

        assert!(!commitment.settled, "commitment already settled");

        // Cross-contract call: fetch verified randomness for the committed round.
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .expect("verifier address not set");
        let verifier_client = DrandVerifierClient::new(&env, &verifier);

        let randomness: Option<BytesN<32>> = verifier_client.get(&commitment.drand_round);
        let rand = randomness.expect("committed round not yet available in verifier");

        // Dice result: first byte of randomness mod 6 + 1 → [1, 6]
        let result: u32 = (rand.get(0).unwrap() % 6) as u32 + 1;

        // Emit event: topics = (tag,), data = (player, round, result)
        env.events().publish(
            (symbol_short!("DiceRoll"),),
            (player.clone(), commitment.drand_round, result),
        );

        // Append to history (keep last 10)
        let mut history: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::History(player.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        history.push_back(result);
        if history.len() > 10 {
            history.pop_front();
        }
        env.storage()
            .persistent()
            .set(&DataKey::History(player.clone()), &history);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::History(player.clone()), MIN_TTL, EXTEND_TO);

        // Mark settled
        let settled = Commitment {
            settled: true,
            ..commitment
        };
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(player), &settled);
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    /// Return the most recent dice result for a player (last settled roll).
    pub fn get_result(env: Env, player: Address) -> Option<u32> {
        let history: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::History(player))?;
        history.last()
    }

    /// Return the last ≤10 dice results for a player, oldest first.
    pub fn get_history(env: Env, player: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::History(player))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Return the pending commitment for a player, if any.
    pub fn get_commitment(env: Env, player: Address) -> Option<Commitment> {
        env.storage()
            .persistent()
            .get(&DataKey::Commitment(player))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    // Minimal mock verifier — implements only `get()`, which is all dice-game calls.
    mod mock_verifier {
        use soroban_sdk::{contract, contractimpl, BytesN, Env};

        #[contract]
        pub struct MockVerifier;

        #[contractimpl]
        impl MockVerifier {
            /// Always returns the same deterministic 32-byte value.
            /// First byte = 0x05, so result = 0x05 % 6 + 1 = 6.
            pub fn get(_env: Env, _round: u64) -> Option<BytesN<32>> {
                Some(BytesN::from_array(
                    &_env,
                    &[
                        0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    ],
                ))
            }
        }
    }

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let verifier_id = env.register(mock_verifier::MockVerifier, ());
        // Pass constructor args as tuple — __constructor receives (verifier,)
        let dice_id = env.register(DiceGame, (&verifier_id,));

        let player = Address::generate(&env);
        (env, dice_id, verifier_id, player)
    }

    #[test]
    fn test_roll_and_settle() {
        let (env, dice_id, _verifier_id, player) = setup();
        let client = DiceGameClient::new(&env, &dice_id);

        // Set ledger timestamp to something after quicknet genesis
        env.ledger().with_mut(|l| {
            l.timestamp = QUICKNET_GENESIS + 1000;
        });

        // current_round ≈ 334, target must be ≥ 344
        let target_round: u64 = 400;
        client.roll(&player, &target_round);

        // Commitment should be stored, unsettled
        let c = client.get_commitment(&player).unwrap();
        assert_eq!(c.drand_round, target_round);
        assert!(!c.settled);

        // Settle (mock verifier returns randomness for any round)
        client.settle(&player);

        // Should now be settled
        let c2 = client.get_commitment(&player).unwrap();
        assert!(c2.settled);

        // Result should be in [1, 6]. First byte of mock randomness = 0x05, 5 % 6 + 1 = 6
        let result = client.get_result(&player).unwrap();
        assert!((1..=6).contains(&result));
        assert_eq!(result, 6); // 0x05 % 6 + 1 = 6

        // History should have one entry
        let history = client.get_history(&player);
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn test_history_capped_at_10() {
        let (env, dice_id, _verifier_id, player) = setup();
        let client = DiceGameClient::new(&env, &dice_id);

        env.ledger().with_mut(|l| {
            l.timestamp = QUICKNET_GENESIS + 1000;
        });

        // Roll and settle 12 times
        for i in 0u64..12 {
            let target = 400 + i;
            client.roll(&player, &target);
            client.settle(&player);
        }

        let history = client.get_history(&player);
        assert_eq!(history.len(), 10, "history must be capped at 10");
    }
}
