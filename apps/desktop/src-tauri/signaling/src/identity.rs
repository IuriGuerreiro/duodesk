use crate::{hex, interfaces};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub certificate_der: String,
    pub private_key_der: String,
}
impl Identity {
    pub fn generate() -> Result<Self, String> {
        let mut names = interfaces();
        names.push("localhost".into());
        names.push("127.0.0.1".into());
        let cert =
            rcgen::generate_simple_self_signed(names).map_err(|_| "Identity generation failed")?;
        Ok(Self {
            certificate_der: hex(cert.cert.der()),
            private_key_der: hex(&cert.key_pair.serialize_der()),
        })
    }
    pub fn certificate(&self) -> Result<rustls::pki_types::CertificateDer<'static>, String> {
        Ok(decode_hex(&self.certificate_der)?.into())
    }
    pub fn fingerprint(&self) -> Result<String, String> {
        Ok(hex(&Sha256::digest(self.certificate()?.as_ref())))
    }
    pub fn acceptor(&self) -> Result<TlsAcceptor, String> {
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(decode_hex(&self.private_key_der)?);
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![self.certificate()?], key.into())
            .map_err(|_| "Invalid TLS identity")?;
        Ok(TlsAcceptor::from(Arc::new(config)))
    }
}
pub(crate) fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty()
        || value.len() > 32768
        || !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid hex".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
            Ok(digit(pair[0]) * 16 + digit(pair[1]))
        })
        .collect()
}
