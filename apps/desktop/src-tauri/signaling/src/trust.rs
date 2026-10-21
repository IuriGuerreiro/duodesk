use crate::{Event, Identity, Invitation, hex, identity::decode_hex, interfaces, random_hex};
use futures_util::{SinkExt, StreamExt};
use ring::signature::{ECDSA_P256_SHA256_ASN1, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
    time::timeout,
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub const DEFAULT_PORT: u16 = 42889;
const CHALLENGE_TTL: Duration = Duration::from_secs(30);
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedPhone {
    pub phone_id: String,
    pub name: String,
    pub public_key: String,
    pub created_at: u64,
}
impl TrustedPhone {
    pub fn validate(&self) -> Result<(), String> {
        let key = decode_hex(&self.public_key)?;
        if key.len() != 65
            || key[0] != 4
            || self.phone_id != hex(&Sha256::digest(&key))
            || self.name.is_empty()
            || self.name.len() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err("Invalid trusted phone".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTrust {
    pub request_id: String,
    pub phone_id: String,
    pub name: String,
    pub public_key: String,
}
struct Pending {
    request: PendingTrust,
    session_id: String,
    expires: Instant,
    replies: mpsc::Sender<String>,
}
struct Registry {
    phones: HashMap<String, TrustedPhone>,
    pending: HashMap<String, Pending>,
    address: String,
    enabled: bool,
    generation: u64,
}
#[derive(Clone)]
pub struct Trust {
    inner: Arc<Mutex<Registry>>,
    pub identity: Identity,
    challenge_ttl: Duration,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
}
pub struct Reconnect {
    pub phone: TrustedPhone,
    generation: u64,
    pub reply: oneshot::Sender<Result<Invitation, String>>,
}
pub struct Listener {
    cancel: watch::Sender<bool>,
    trust: Trust,
    pub address: String,
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.trust.disable();
        let _ = self.cancel.send(true);
    }
}
impl Trust {
    pub fn new(
        identity: Identity,
        phones: Vec<TrustedPhone>,
        address: String,
        emit: Arc<dyn Fn(Event) + Send + Sync>,
    ) -> Result<Self, String> {
        identity.acceptor()?;
        let trust = Self {
            inner: Arc::new(Mutex::new(Registry {
                phones: HashMap::new(),
                pending: HashMap::new(),
                address,
                enabled: false,
                generation: 0,
            })),
            identity,
            challenge_ttl: CHALLENGE_TTL,
            emit,
        };
        trust.update(phones)?;
        Ok(trust)
    }
    pub fn update(&self, phones: Vec<TrustedPhone>) -> Result<(), String> {
        if phones.len() > 100 {
            return Err("Too many trusted phones".into());
        }
        let mut next = HashMap::new();
        for phone in phones {
            phone.validate()?;
            if next.insert(phone.phone_id.clone(), phone).is_some() {
                return Err("Duplicate phone".into());
            }
        }
        let mut registry = self.inner.lock().unwrap();
        registry.phones = next;
        registry.generation += 1;
        Ok(())
    }
    pub fn disable(&self) {
        let mut registry = self.inner.lock().unwrap();
        registry.enabled = false;
        registry.generation += 1;
    }
    pub(crate) fn expire_pending(&self) {
        let mut registry = self.inner.lock().unwrap();
        let count = registry.pending.len();
        registry
            .pending
            .retain(|_, p| p.expires > Instant::now() && !p.replies.is_closed());
        let changed = count != registry.pending.len();
        drop(registry);
        if changed {
            (self.emit)(Event::TrustPendingChanged);
        }
    }
    pub fn pending(&self) -> Vec<PendingTrust> {
        self.expire_pending();
        self.inner
            .lock()
            .unwrap()
            .pending
            .values()
            .map(|p| p.request.clone())
            .collect()
    }
    pub fn pending_phone(&self, id: &str) -> Result<TrustedPhone, String> {
        let registry = self.inner.lock().unwrap();
        let p = registry
            .pending
            .get(id)
            .filter(|p| p.expires > Instant::now() && !p.replies.is_closed())
            .ok_or("Enrollment expired")?;
        Ok(TrustedPhone {
            phone_id: p.request.phone_id.clone(),
            name: p.request.name.clone(),
            public_key: p.request.public_key.clone(),
            created_at: crate::now_ms(),
        })
    }
    pub fn decide(&self, request_id: &str, approve: bool) -> Result<(), String> {
        let mut registry = self.inner.lock().unwrap();
        let pending = registry
            .pending
            .remove(request_id)
            .ok_or("Unknown enrollment")?;
        if pending.expires <= Instant::now() {
            return Err("Enrollment expired".into());
        }
        if approve
            && registry
                .phones
                .get(&pending.request.phone_id)
                .is_none_or(|p| p.public_key != pending.request.public_key)
        {
            return Err("Phone was not persisted".into());
        }
        let message = if approve {
            json!({"v":1,"sessionId":pending.session_id,"type":"trust_committed","phoneId":pending.request.phone_id,"fingerprint":self.identity.fingerprint()?,"address":registry.address})
        } else {
            json!({"v":1,"sessionId":pending.session_id,"type":"trust_rejected","phoneId":pending.request.phone_id,"reason":"Desktop declined trust"})
        };
        pending
            .replies
            .try_send(message.to_string())
            .map_err(|_| "Enrollment connection closed".to_string())?;
        drop(registry);
        (self.emit)(Event::TrustPendingChanged);
        Ok(())
    }
    pub(crate) fn clear_session(&self, session_id: &str) {
        self.inner
            .lock()
            .unwrap()
            .pending
            .retain(|_, p| p.session_id != session_id);
        (self.emit)(Event::TrustPendingChanged);
    }
    pub(crate) fn enroll(
        &self,
        text: &str,
        session_id: &str,
        replies: &mpsc::Sender<String>,
        emit: &Arc<dyn Fn(Event) + Send + Sync>,
    ) -> Result<bool, String> {
        let value: Value = serde_json::from_str(text).map_err(|_| "Invalid JSON")?;
        if value["type"] != "trust_enroll" {
            return Ok(false);
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Enrollment {
            v: u8,
            session_id: String,
            r#type: String,
            phone_id: String,
            name: String,
            public_key: String,
        }
        let request: Enrollment =
            serde_json::from_value(value).map_err(|_| "Invalid enrollment")?;
        if request.v != 1 || request.session_id != session_id || request.r#type != "trust_enroll" {
            return Err("Invalid enrollment session".into());
        }
        let phone = TrustedPhone {
            phone_id: request.phone_id,
            name: request.name,
            public_key: request.public_key,
            created_at: 0,
        };
        phone.validate()?;
        let pending = PendingTrust {
            request_id: random_hex(16),
            phone_id: phone.phone_id,
            name: phone.name,
            public_key: phone.public_key,
        };
        let mut registry = self.inner.lock().unwrap();
        registry
            .pending
            .retain(|_, p| p.expires > Instant::now() && !p.replies.is_closed());
        if registry.pending.len() >= 4
            || registry
                .pending
                .values()
                .any(|p| p.session_id == session_id)
        {
            return Err("Enrollment already pending".into());
        }
        registry.pending.insert(
            pending.request_id.clone(),
            Pending {
                request: pending.clone(),
                session_id: session_id.into(),
                expires: Instant::now() + Duration::from_secs(120),
                replies: replies.clone(),
            },
        );
        drop(registry);
        emit(Event::TrustEnrollment { request: pending });
        Ok(true)
    }
    pub fn accepts(&self, reconnect: &Reconnect) -> bool {
        self.current(&reconnect.phone, reconnect.generation)
    }
    fn current(&self, phone: &TrustedPhone, generation: u64) -> bool {
        let registry = self.inner.lock().unwrap();
        registry.enabled
            && registry.generation == generation
            && registry.phones.get(&phone.phone_id) == Some(phone)
    }
    pub async fn listen(
        &self,
        ip: &str,
        port: u16,
        handoffs: mpsc::Sender<Reconnect>,
    ) -> Result<Listener, String> {
        if !interfaces().iter().any(|i| i == ip) {
            return Err("Select a local IPv4 interface".into());
        }
        let tcp = TcpListener::bind((ip, port))
            .await
            .map_err(|_| "Trusted reconnect port unavailable")?;
        let address = tcp
            .local_addr()
            .map_err(|_| "Listener unavailable")?
            .to_string();
        let acceptor = self.identity.acceptor()?;
        {
            let mut registry = self.inner.lock().unwrap();
            registry.address = address.clone();
            registry.enabled = true;
            registry.generation += 1;
        }
        let (cancel, mut cancelled) = watch::channel(false);
        let trust = self.clone();
        tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    connection = tcp.accept(), if tasks.len() < 8 => {
                        let Ok((tcp, _)) = connection else { break };
                        let trust = trust.clone();
                        let acceptor = acceptor.clone();
                        let handoffs = handoffs.clone();
                        tasks.spawn(async move {
                            let _ = timeout(Duration::from_secs(40), async {
                                let tls = timeout(Duration::from_secs(5), acceptor.accept(tcp)).await.map_err(|_| "TLS timeout")?.map_err(|_| "TLS failed")?;
                                let config = WebSocketConfig::default().max_message_size(Some(4096)).max_frame_size(Some(4096));
                                let mut ws = timeout(Duration::from_secs(5), accept_async_with_config(tls, Some(config))).await.map_err(|_| "WebSocket timeout")?.map_err(|_| "WebSocket failed")?;
                                let message = timeout(Duration::from_secs(5), ws.next()).await.map_err(|_| "Request timeout")?.ok_or("Closed")?.map_err(|_| "Read failed")?.into_text().map_err(|_| "Expected text")?;
                                let request: Connect = serde_json::from_str(&message).map_err(|_| "Invalid reconnect")?;
                                if request.v != 1 || request.r#type != "trust_connect" { return Err("Invalid reconnect"); }
                                let (phone, generation) = {
                                    let registry = trust.inner.lock().unwrap();
                                    if !registry.enabled { return Err("Disabled"); }
                                    (registry.phones.get(&request.phone_id).cloned().ok_or("Unknown phone")?, registry.generation)
                                };
                                let nonce = random_hex(32);
                                let fingerprint = trust.identity.fingerprint().map_err(|_| "Identity unavailable")?;
                                let challenge = json!({"v":1,"type":"trust_challenge","phoneId":phone.phone_id,"fingerprint":fingerprint,"nonce":nonce});
                                let expires = Instant::now() + trust.challenge_ttl;
                                ws.send(Message::text(challenge.to_string())).await.map_err(|_| "Send failed")?;
                                let proof = timeout(trust.challenge_ttl, ws.next()).await.map_err(|_| "Expired")?.ok_or("Closed")?.map_err(|_| "Read failed")?.into_text().map_err(|_| "Expected text")?;
                                let proof: Proof = serde_json::from_str(&proof).map_err(|_| "Invalid proof")?;
                                if proof.v != 1 || proof.r#type != "trust_proof" || proof.phone_id != phone.phone_id || Instant::now() >= expires { return Err("Invalid proof identity or expiry"); }
                                let bytes = proof_bytes(&nonce, &fingerprint, &phone.phone_id).map_err(|_| "Invalid challenge")?;
                                let key = decode_hex(&phone.public_key).map_err(|_| "Invalid key")?;
                                let signature = decode_hex(&proof.signature).map_err(|_| "Invalid signature")?;
                                UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, key).verify(&bytes, &signature).map_err(|_| "Proof rejected")?;
                                if !trust.current(&phone, generation) { return Err("Revoked or disabled"); }
                                let (reply, result) = oneshot::channel();
                                handoffs.try_send(Reconnect { phone: phone.clone(), generation, reply }).map_err(|_| "Host busy")?;
                                let invitation = timeout(Duration::from_secs(5), result).await.map_err(|_| "Host timeout")?.map_err(|_| "Host closed")?.map_err(|_| "Host rejected")?;
                                if !trust.current(&phone, generation) { return Err("Revoked or disabled"); }
                                ws.send(Message::text(json!({"v":1,"type":"trust_invitation","invitation":invitation}).to_string())).await.map_err(|_| "Send failed")?;
                                let _ = ws.close(None).await;
                                Ok::<(), &str>(())
                            }).await;
                        });
                    }
                }
            }
            tasks.abort_all();
        });
        Ok(Listener {
            cancel,
            trust: self.clone(),
            address,
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connect {
    v: u8,
    r#type: String,
    phone_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    v: u8,
    r#type: String,
    phone_id: String,
    signature: String,
}
pub fn proof_bytes(nonce: &str, fingerprint: &str, phone_id: &str) -> Result<Vec<u8>, String> {
    let mut bytes = b"DuoDesk trusted reconnect v1\n".to_vec();
    for value in [nonce, fingerprint, phone_id] {
        let decoded = decode_hex(value)?;
        if decoded.len() != 32 {
            return Err("Invalid challenge field".into());
        }
        bytes.extend(decoded);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
