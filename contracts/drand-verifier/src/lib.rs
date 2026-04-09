#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    crypto::bls12_381::{G1Affine, G2Affine},
    vec, Bytes, BytesN, Env, Vec,
};

// ---------------------------------------------------------------------------
// drand quicknet BLS12-381 constants
//
// Chain: 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
// Scheme: bls-unchained-g1-rfc9380  (unchained, 3-second period)
// Signature: G1 (96 bytes uncompressed)
// Public key: G2 (192 bytes uncompressed)
//
// Soroban encoding (from soroban-sdk source):
//   G1 (96 bytes):  X_be(48) || Y_be(48)                         — no flag bits
//   G2 (192 bytes): X_c1(48) || X_c0(48) || Y_c1(48) || Y_c0(48)— no flag bits
//
// Constants generated via scripts/gen-bls-constants.mjs using @noble/curves.
// ---------------------------------------------------------------------------

/// drand quicknet public key — G2 uncompressed (192 bytes, Soroban format).
/// Verified from: GET https://api.drand.sh/<chain>/info
const DRAND_PK: [u8; 192] = [
    // X_c1
    0x03, 0xcf, 0x0f, 0x28, 0x96, 0xad, 0xee, 0x7e,
    0xb8, 0xb5, 0xf0, 0x1f, 0xca, 0xd3, 0x91, 0x22,
    0x12, 0xc4, 0x37, 0xe0, 0x07, 0x3e, 0x91, 0x1f,
    0xb9, 0x00, 0x22, 0xd3, 0xe7, 0x60, 0x18, 0x3c,
    0x8c, 0x4b, 0x45, 0x0b, 0x6a, 0x0a, 0x6c, 0x3a,
    0xc6, 0xa5, 0x77, 0x6a, 0x2d, 0x10, 0x64, 0x51,
    // X_c0
    0x0d, 0x1f, 0xec, 0x75, 0x8c, 0x92, 0x1c, 0xc2,
    0x2b, 0x0e, 0x17, 0xe6, 0x3a, 0xaf, 0x4b, 0xcb,
    0x5e, 0xd6, 0x63, 0x04, 0xde, 0x9c, 0xf8, 0x09,
    0xbd, 0x27, 0x4c, 0xa7, 0x3b, 0xab, 0x4a, 0xf5,
    0xa6, 0xe9, 0xc7, 0x6a, 0x4b, 0xc0, 0x9e, 0x76,
    0xea, 0xe8, 0x99, 0x1e, 0xf5, 0xec, 0xe4, 0x5a,
    // Y_c1
    0x01, 0xa7, 0x14, 0xf2, 0xed, 0xb7, 0x41, 0x19,
    0xa2, 0xf2, 0xb0, 0xd5, 0xa7, 0xc7, 0x5b, 0xa9,
    0x02, 0xd1, 0x63, 0x70, 0x0a, 0x61, 0xbc, 0x22,
    0x4e, 0xde, 0xdd, 0x8e, 0x63, 0xae, 0xf7, 0xbe,
    0x1a, 0xaf, 0x8e, 0x93, 0xd7, 0xa9, 0x71, 0x8b,
    0x04, 0x7c, 0xcd, 0xdb, 0x3e, 0xb5, 0xd6, 0x8b,
    // Y_c0
    0x0e, 0x5d, 0xb2, 0xb6, 0xbf, 0xbb, 0x01, 0xc8,
    0x67, 0x74, 0x9c, 0xad, 0xff, 0xca, 0x88, 0xb3,
    0x6c, 0x24, 0xf3, 0x01, 0x2b, 0xa0, 0x9f, 0xc4,
    0xd3, 0x02, 0x2c, 0x5c, 0x37, 0xdc, 0xe0, 0xf9,
    0x77, 0xd3, 0xad, 0xb5, 0xd1, 0x83, 0xc7, 0x47,
    0x7c, 0x44, 0x2b, 0x1f, 0x04, 0x51, 0x52, 0x73,
];

/// Negated BLS12-381 G2 generator — uncompressed (192 bytes, Soroban format).
///
/// Used for pairing check: e(σ, -g2) · e(H(m), pk) == 1
/// (equivalent to the standard BLS verify: e(σ, g2) == e(H(m), pk))
const NEG_G2_GEN: [u8; 192] = [
    // X_c1 (same as positive generator)
    0x13, 0xe0, 0x2b, 0x60, 0x52, 0x71, 0x9f, 0x60,
    0x7d, 0xac, 0xd3, 0xa0, 0x88, 0x27, 0x4f, 0x65,
    0x59, 0x6b, 0xd0, 0xd0, 0x99, 0x20, 0xb6, 0x1a,
    0xb5, 0xda, 0x61, 0xbb, 0xdc, 0x7f, 0x50, 0x49,
    0x33, 0x4c, 0xf1, 0x12, 0x13, 0x94, 0x5d, 0x57,
    0xe5, 0xac, 0x7d, 0x05, 0x5d, 0x04, 0x2b, 0x7e,
    // X_c0 (same as positive generator)
    0x02, 0x4a, 0xa2, 0xb2, 0xf0, 0x8f, 0x0a, 0x91,
    0x26, 0x08, 0x05, 0x27, 0x2d, 0xc5, 0x10, 0x51,
    0xc6, 0xe4, 0x7a, 0xd4, 0xfa, 0x40, 0x3b, 0x02,
    0xb4, 0x51, 0x0b, 0x64, 0x7a, 0xe3, 0xd1, 0x77,
    0x0b, 0xac, 0x03, 0x26, 0xa8, 0x05, 0xbb, 0xef,
    0xd4, 0x80, 0x56, 0xc8, 0xc1, 0x21, 0xbd, 0xb8,
    // Y_c1 (negated)
    0x13, 0xfa, 0x4d, 0x4a, 0x0a, 0xd8, 0xb1, 0xce,
    0x18, 0x6e, 0xd5, 0x06, 0x17, 0x89, 0x21, 0x3d,
    0x99, 0x39, 0x23, 0x06, 0x6d, 0xdd, 0xaf, 0x10,
    0x40, 0xbc, 0x3f, 0xf5, 0x9f, 0x82, 0x5c, 0x78,
    0xdf, 0x74, 0xf2, 0xd7, 0x54, 0x67, 0xe2, 0x5e,
    0x0f, 0x55, 0xf8, 0xa0, 0x0f, 0xa0, 0x30, 0xed,
    // Y_c0 (negated)
    0x0d, 0x1b, 0x3c, 0xc2, 0xc7, 0x02, 0x78, 0x88,
    0xbe, 0x51, 0xd9, 0xef, 0x69, 0x1d, 0x77, 0xbc,
    0xb6, 0x79, 0xaf, 0xda, 0x66, 0xc7, 0x3f, 0x17,
    0xf9, 0xee, 0x38, 0x37, 0xa5, 0x50, 0x24, 0xf7,
    0x8c, 0x71, 0x36, 0x32, 0x75, 0xa7, 0x5d, 0x75,
    0xd8, 0x6b, 0xab, 0x79, 0xf7, 0x47, 0x82, 0xaa,
];

/// RFC 9380 DST for drand quicknet's hash-to-G1.
const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

const MIN_TTL: u32 = 17_280;
const EXTEND_TO: u32 = 518_400;

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    /// Persistent: round → verified randomness (BytesN<32>)
    Randomness(u64),
    /// Instance: most recently verified round number
    LatestRound,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DrandVerifier;

#[contractimpl]
impl DrandVerifier {
    /// Submit a drand quicknet beacon for on-chain BLS12-381 verification.
    ///
    /// `signature` is the G1 signature in **uncompressed Soroban format** (96 bytes).
    /// The feeder must decompress the 48-byte compressed signature from the
    /// drand API before calling this function.
    ///
    /// Anyone may call push() — the pairing check is the trust anchor.
    /// Returns true if valid and stored; false if verification fails.
    ///
    /// Verification:
    ///   1. msg    = sha256(round as big-endian u64)
    ///   2. H(m)   = hash_to_g1(msg, DST)
    ///   3. check  = pairing_check([σ, H(m)], [-g2_gen, pk])
    ///             = e(σ, -g2) · e(H(m), pk) == 1
    ///             ≡ e(σ, g2) == e(H(m), pk)
    pub fn push(env: Env, round: u64, signature: BytesN<96>) -> bool {
        // 1. Build message: sha256(round as big-endian u64)
        let round_be: [u8; 8] = round.to_be_bytes();
        let msg_hash: BytesN<32> = env.crypto().sha256(&Bytes::from_slice(&env, &round_be)).into();
        let msg_hash_bytes: Bytes = msg_hash.into();

        // 2. Hash-to-G1 with drand quicknet DST
        let bls = env.crypto().bls12_381();
        let dst_bytes = Bytes::from_slice(&env, DST);
        let msg_g1: G1Affine = bls.hash_to_g1(&msg_hash_bytes, &dst_bytes);

        // 3. Decode points
        let sig_g1: G1Affine = G1Affine::from_bytes(signature.clone());
        let neg_gen_g2: G2Affine = G2Affine::from_bytes(BytesN::from_array(&env, &NEG_G2_GEN));
        let pk_g2: G2Affine = G2Affine::from_bytes(BytesN::from_array(&env, &DRAND_PK));

        // 4. Pairing check: e(σ, -g2_gen) · e(H(m), pk) == 1
        //    pairing_check takes two parallel Vecs: [G1...] and [G2...]
        let vp1: Vec<G1Affine> = vec![&env, sig_g1, msg_g1];
        let vp2: Vec<G2Affine> = vec![&env, neg_gen_g2, pk_g2];
        let valid = bls.pairing_check(vp1, vp2);

        if valid {
            // 5. Randomness = sha256(signature bytes) — re-derive, don't trust API field
            let sig_bytes: Bytes = signature.into();
            let randomness: BytesN<32> = env.crypto().sha256(&sig_bytes).into();

            // Persist with ~30-day TTL
            env.storage()
                .persistent()
                .set(&DataKey::Randomness(round), &randomness);
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::Randomness(round), MIN_TTL, EXTEND_TO);

            // Update latest round (only advance, never regress)
            let prev: Option<u64> = env.storage().instance().get(&DataKey::LatestRound);
            if prev.map(|r| round > r).unwrap_or(true) {
                env.storage().instance().set(&DataKey::LatestRound, &round);
            }
            env.storage().instance().extend_ttl(MIN_TTL, EXTEND_TO);
        }

        valid
    }

    /// Return verified randomness for a specific round, if stored.
    pub fn get(env: Env, round: u64) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::Randomness(round))
    }

    /// Return (round, randomness) for the most recently verified round.
    /// Panics if no round has been pushed yet.
    pub fn latest(env: Env) -> (u64, BytesN<32>) {
        let round: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LatestRound)
            .expect("no round verified yet");
        let randomness: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::Randomness(round))
            .expect("latest round data missing");
        (round, randomness)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    /// Real drand quicknet beacon, round 27613645.
    /// Signature converted from compressed (48 bytes) to uncompressed Soroban
    /// format (96 bytes) using scripts/gen-bls-constants.mjs.
    ///
    /// Compressed (from API): ae1e6029b93cb2da10fc8df2adf40d0614b0bb817ed6687a
    ///                        bbc8ba1d9fc1e3d6f9b3c0a068d4be399ec149a727bc2f0d
    const TEST_ROUND: u64 = 27_613_645;
    const TEST_SIG: [u8; 96] = [
        // X coordinate (48 bytes)
        0x0e, 0x1e, 0x60, 0x29, 0xb9, 0x3c, 0xb2, 0xda,
        0x10, 0xfc, 0x8d, 0xf2, 0xad, 0xf4, 0x0d, 0x06,
        0x14, 0xb0, 0xbb, 0x81, 0x7e, 0xd6, 0x68, 0x7a,
        0xbb, 0xc8, 0xba, 0x1d, 0x9f, 0xc1, 0xe3, 0xd6,
        0xf9, 0xb3, 0xc0, 0xa0, 0x68, 0xd4, 0xbe, 0x39,
        0x9e, 0xc1, 0x49, 0xa7, 0x27, 0xbc, 0x2f, 0x0d,
        // Y coordinate (48 bytes)
        0x17, 0x3c, 0xf1, 0x8d, 0x48, 0xee, 0x28, 0xd9,
        0x71, 0xdc, 0xb7, 0x7d, 0x74, 0x11, 0x53, 0x12,
        0x6b, 0x8e, 0x9c, 0xad, 0x9a, 0x90, 0x5e, 0x19,
        0x3c, 0xc3, 0xc6, 0x59, 0xb6, 0x86, 0xde, 0xd9,
        0xad, 0xc2, 0x6b, 0x28, 0xdf, 0x96, 0xa0, 0xe6,
        0x9c, 0x5e, 0xa1, 0x7a, 0xeb, 0xa7, 0x63, 0xc6,
    ];

    #[test]
    fn test_push_valid_beacon() {
        let env = Env::default();
        let contract_id = env.register(DrandVerifier, ());
        let client = DrandVerifierClient::new(&env, &contract_id);

        let sig = BytesN::from_array(&env, &TEST_SIG);
        let result = client.push(&TEST_ROUND, &sig);
        assert!(result, "valid beacon signature must be accepted");

        let stored = client.get(&TEST_ROUND);
        assert!(stored.is_some(), "randomness must be stored after valid push");

        let (latest_round, _) = client.latest();
        assert_eq!(latest_round, TEST_ROUND);
    }

    /// G1 generator in Soroban uncompressed format (96 bytes: X||Y).
    /// Used as a "syntactically valid but semantically wrong" signature.
    const G1_GEN: [u8; 96] = [
        // X
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94,
        0x26, 0x95, 0x63, 0x8c, 0x4f, 0xa9, 0xac, 0x0f,
        0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58,
        0x6c, 0x55, 0xe8, 0x3f, 0xf9, 0x7a, 0x1a, 0xef,
        0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        // Y
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1,
        0xa0, 0x9e, 0x30, 0xed, 0x74, 0x1d, 0x8a, 0xe4,
        0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed,
        0xd0, 0x3c, 0xc7, 0x44, 0xa2, 0x88, 0x8a, 0xe4,
        0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];

    /// Submitting a valid G1 point that is not the correct signature for the
    /// round must fail the pairing check and return false.
    #[test]
    fn test_push_wrong_sig_rejected() {
        let env = Env::default();
        let contract_id = env.register(DrandVerifier, ());
        let client = DrandVerifierClient::new(&env, &contract_id);

        // G1 generator is a valid point on the curve but not a valid sig for this round.
        let wrong_sig = BytesN::from_array(&env, &G1_GEN);
        let result = client.push(&TEST_ROUND, &wrong_sig);
        assert!(!result, "wrong (but valid-point) sig must be rejected");
        assert!(client.get(&TEST_ROUND).is_none());
    }

    /// Submitting a byte string that is not a valid G1 point must panic —
    /// the Soroban host rejects malformed cryptographic inputs immediately.
    #[test]
    #[should_panic]
    fn test_push_invalid_point_panics() {
        let env = Env::default();
        let contract_id = env.register(DrandVerifier, ());
        let client = DrandVerifierClient::new(&env, &contract_id);

        // Flip last byte of the valid sig → point not on curve.
        let mut bad_sig = TEST_SIG;
        bad_sig[95] ^= 0xff;
        let sig = BytesN::from_array(&env, &bad_sig);
        client.push(&TEST_ROUND, &sig);
    }

    #[test]
    fn test_latest_advances_monotonically() {
        let env = Env::default();
        let contract_id = env.register(DrandVerifier, ());
        let client = DrandVerifierClient::new(&env, &contract_id);

        let sig = BytesN::from_array(&env, &TEST_SIG);
        client.push(&TEST_ROUND, &sig);

        let (round, _) = client.latest();
        assert_eq!(round, TEST_ROUND);
    }
}
