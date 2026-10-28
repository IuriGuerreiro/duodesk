//! P-256 identity, canonical encodings and the exact transcripts both apps sign.
//! Keys: SEC1 uncompressed points (65 bytes). Signatures: ASN.1 DER ECDSA over SHA-256.
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{
        ECDSA_P256_SHA256_ASN1, ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair,
        UnparsedPublicKey,
    },
};
use sha2::{Digest, Sha256};

pub const ENROLL_PURPOSE: &str = "duodesk-enroll-v1";
pub const RECONNECT_PURPOSE: &str = "duodesk-reconnect-v1";

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2)
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn is_public_key(text: &str) -> bool {
    text.len() == 130 && text.starts_with("04") && unhex(text).is_some()
}

pub fn is_nonce(text: &str) -> bool {
    text.len() == 64 && unhex(text).is_some()
}

/// Shape only; the verifier enforces strict DER.
pub fn is_signature(text: &str) -> bool {
    (16..=144).contains(&text.len()) && text.starts_with("30") && unhex(text).is_some()
}

pub fn nonce() -> String {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("system randomness");
    hex(&bytes)
}

/// This install's long-lived identity. The PKCS#8 document never leaves the process or secure storage.
pub struct Identity {
    pkcs8: Vec<u8>,
    pair: EcdsaKeyPair,
}

impl Identity {
    pub fn generate() -> Result<Self, String> {
        let rng = SystemRandom::new();
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
            .map_err(|_| "Could not create a device identity")?;
        Self::from_pkcs8(doc.as_ref())
    }

    pub fn from_pkcs8(pkcs8: &[u8]) -> Result<Self, String> {
        let pair =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8, &SystemRandom::new())
                .map_err(|_| "Stored device identity is unreadable")?;
        Ok(Self {
            pkcs8: pkcs8.to_vec(),
            pair,
        })
    }

    pub fn pkcs8(&self) -> &[u8] {
        &self.pkcs8
    }

    /// Lowercase hex of the 65-byte uncompressed point.
    pub fn public_key(&self) -> String {
        hex(self.pair.public_key().as_ref())
    }

    pub fn sign(&self, message: &str) -> String {
        hex(self
            .pair
            .sign(&SystemRandom::new(), message.as_bytes())
            .expect("ECDSA signing")
            .as_ref())
    }
}

pub fn verify(public_key: &str, message: &str, signature: &str) -> bool {
    let (Some(key), Some(sig)) = (unhex(public_key), unhex(signature)) else {
        return false;
    };
    is_public_key(public_key)
        && UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, key)
            .verify(message.as_bytes(), &sig)
            .is_ok()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Signer {
    Desktop,
    Phone,
}

pub struct EnrollFields<'a> {
    pub session_id: &'a str,
    pub certificate_fingerprint: &'a str,
    pub token_hash: &'a str,
    pub desktop_key: &'a str,
    pub phone_key: &'a str,
    pub desktop_nonce: &'a str,
    pub phone_nonce: &'a str,
}

pub fn enroll_transcript(signer: Signer, f: &EnrollFields) -> String {
    [
        ENROLL_PURPOSE,
        match signer {
            Signer::Desktop => "desktop",
            Signer::Phone => "phone",
        },
        f.session_id,
        f.certificate_fingerprint,
        f.token_hash,
        f.desktop_key,
        f.phone_key,
        f.desktop_nonce,
        f.phone_nonce,
    ]
    .join("\n")
}

pub fn reconnect_transcript(
    desktop_key: &str,
    phone_key: &str,
    server_nonce: &str,
    client_nonce: &str,
) -> String {
    [
        RECONNECT_PURPOSE,
        "phone",
        desktop_key,
        phone_key,
        server_nonce,
        client_nonce,
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../../packages/protocol/test/vectors/trust-v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn shared_vectors_verify() {
        let v = vectors();
        let s = |path: &str| v.pointer(path).unwrap().as_str().unwrap().to_string();
        assert_eq!(
            sha256_hex(&unhex(&s("/desktop/publicKey")).unwrap()),
            s("/desktop/fingerprint")
        );
        assert_eq!(
            sha256_hex(&unhex(&s("/token")).unwrap()),
            s("/enroll/tokenHash")
        );
        let (session, cert, token, dk, pk, dn, pn) = (
            s("/enroll/sessionId"),
            s("/enroll/certificateFingerprint"),
            s("/enroll/tokenHash"),
            s("/enroll/desktopKey"),
            s("/enroll/phoneKey"),
            s("/enroll/desktopNonce"),
            s("/enroll/phoneNonce"),
        );
        let fields = EnrollFields {
            session_id: &session,
            certificate_fingerprint: &cert,
            token_hash: &token,
            desktop_key: &dk,
            phone_key: &pk,
            desktop_nonce: &dn,
            phone_nonce: &pn,
        };
        let desktop = enroll_transcript(Signer::Desktop, &fields);
        let phone = enroll_transcript(Signer::Phone, &fields);
        assert_eq!(desktop, s("/enroll/desktopTranscript"));
        assert_eq!(phone, s("/enroll/phoneTranscript"));
        assert!(verify(&dk, &desktop, &s("/enroll/desktopSignature")));
        assert!(verify(&pk, &phone, &s("/enroll/phoneSignature")));
        assert!(!verify(&dk, &phone, &s("/enroll/desktopSignature")));
        assert!(!verify(&pk, &desktop, &s("/enroll/phoneSignature")));
        let reconnect = reconnect_transcript(
            &s("/reconnect/desktopKey"),
            &s("/reconnect/phoneKey"),
            &s("/reconnect/serverNonce"),
            &s("/reconnect/clientNonce"),
        );
        assert_eq!(reconnect, s("/reconnect/transcript"));
        assert!(verify(&pk, &reconnect, &s("/reconnect/phoneSignature")));
    }

    #[test]
    fn identity_round_trips_and_signs_der() {
        let identity = Identity::generate().unwrap();
        let again = Identity::from_pkcs8(identity.pkcs8()).unwrap();
        assert_eq!(identity.public_key(), again.public_key());
        assert!(is_public_key(&identity.public_key()));
        let signature = identity.sign("hello");
        assert!(is_signature(&signature));
        assert!(verify(&again.public_key(), "hello", &signature));
        assert!(!verify(&again.public_key(), "hellO", &signature));
        assert!(!verify(
            &Identity::generate().unwrap().public_key(),
            "hello",
            &signature
        ));
    }
}
