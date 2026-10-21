use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
mod identity;
mod pairing;
pub mod trust;
pub use identity::Identity;
pub use pairing::{NetworkAddress, PairReply};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, Ipv4Addr},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub const MAX_BYTES: usize = 65_536;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Signal {
    pub v: u8,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(flatten)]
    pub payload: Payload,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Payload {
    Pair {
        token: String,
    },
    Paired,
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_m_line_index: u16,
    },
    Stop,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub v: u8,
    pub session_id: String,
    pub url: String,
    pub token: String,
    pub fingerprint: String,
    pub expires_at: u64,
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    PairingStatus {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: String,
    },
    Pairing {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        message: String,
    },
    Signal {
        signal: Signal,
    },
    #[serde(rename = "trust_enrollment")]
    TrustEnrollment {
        request: trust::PendingTrust,
    },
    #[serde(rename = "trust_pending_changed")]
    TrustPendingChanged,
    #[serde(rename = "trust_reconnected")]
    TrustReconnected {
        #[serde(rename = "phoneId")]
        phone_id: String,
        invitation: Invitation,
    },
    State {
        #[serde(rename = "sessionId")]
        session_id: String,
        state: String,
    },
}
pub struct Session {
    pub invitation: Invitation,
    pub pairing_address: String,
    pairing_replies: mpsc::Sender<PairReply>,
    outgoing: mpsc::Sender<Signal>,
    cancel: watch::Sender<bool>,
    #[cfg(test)]
    certificate: rustls::pki_types::CertificateDer<'static>,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
impl Session {
    pub fn pair_reply(&self, reply: PairReply) -> Result<(), String> {
        if reply.message.len() > 8192
            || reply.message.contains('\n')
            || reply.request_id.len() != 32
            || !reply
                .request_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid pairing reply".into());
        }
        self.pairing_replies
            .try_send(reply)
            .map_err(|_| "Pairing closed or busy".into())
    }
    pub fn send(&self, signal: Signal) -> Result<(), String> {
        validate(&signal, &self.invitation.session_id)?;
        if !matches!(
            signal.payload,
            Payload::Answer { .. } | Payload::Candidate { .. } | Payload::Stop
        ) {
            return Err("Unexpected receiver message".into());
        }
        self.outgoing
            .try_send(signal)
            .map_err(|_| "Session closed or busy".into())
    }
}
pub fn network_addresses() -> Result<Vec<NetworkAddress>, String> {
    let mut result: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|_| "Could not enumerate network interfaces")?
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) => Some(NetworkAddress::new(i.name, ip)),
            _ => None,
        })
        .collect();
    result.sort_by(|a, b| {
        (a.kind != "lan", &a.name, &a.address).cmp(&(b.kind != "lan", &b.name, &b.address))
    });
    result.dedup_by(|a, b| a.name == b.name && a.address == b.address);
    Ok(result)
}
pub fn interfaces() -> Vec<String> {
    network_addresses()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.selectable)
        .map(|a| a.address)
        .collect()
}
fn random_hex(bytes: usize) -> String {
    let mut data = vec![0; bytes];
    rand::thread_rng().fill_bytes(&mut data);
    hex(&data)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn validate(signal: &Signal, session_id: &str) -> Result<(), String> {
    if signal.v != 1 || signal.session_id != session_id {
        return Err("Invalid session".into());
    }
    match &signal.payload {
        Payload::Offer { sdp } | Payload::Answer { sdp }
            if sdp.is_empty() || sdp.len() > 60_000 =>
        {
            return Err("Invalid SDP".into());
        }
        Payload::Candidate {
            candidate,
            sdp_mid,
            sdp_m_line_index,
        } if candidate.is_empty()
            || candidate.len() > 8192
            || sdp_mid.as_ref().is_some_and(|s| s.len() > 256)
            || *sdp_m_line_index > 32 =>
        {
            return Err("Invalid candidate".into());
        }
        _ => {}
    }
    Ok(())
}
fn parse(text: &str, session_id: &str) -> Result<Signal, String> {
    if text.len() > MAX_BYTES {
        return Err("Message too large".into());
    }
    // Validate exact fields before serde decoding; flattened enums otherwise accept extra fields.
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "Invalid JSON")?;
    let fields = match value.get("type").and_then(|v| v.as_str()) {
        Some("pair") => vec!["v", "sessionId", "type", "token"],
        Some("offer" | "answer") => vec!["v", "sessionId", "type", "sdp"],
        Some("candidate") => vec![
            "v",
            "sessionId",
            "type",
            "candidate",
            "sdpMid",
            "sdpMLineIndex",
        ],
        Some("paired" | "stop") => vec!["v", "sessionId", "type"],
        _ => return Err("Invalid message type".into()),
    };
    let object = value.as_object().ok_or("Invalid object")?;
    if object.len() != fields.len() || !fields.iter().all(|key| object.contains_key(*key)) {
        return Err("Invalid fields".into());
    }
    let signal: Signal = serde_json::from_value(value).map_err(|_| "Invalid message")?;
    validate(&signal, session_id)?;
    Ok(signal)
}

fn valid_pair(signal: &Signal, invitation: &Invitation, now: u64) -> bool {
    validate(signal, &invitation.session_id).is_ok()
        && now < invitation.expires_at
        && matches!(&signal.payload, Payload::Pair { token } if token == &invitation.token)
}

pub async fn start(ip: String, emit: Arc<dyn Fn(Event) + Send + Sync>) -> Result<Session, String> {
    if !interfaces().contains(&ip) || ip.parse::<Ipv4Addr>().is_err() {
        return Err("Select a local IPv4 interface".into());
    }
    start_with_identity(ip, emit, Identity::generate()?, None).await
}

pub async fn start_with_identity(
    ip: String,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    identity: Identity,
    trust: Option<trust::Trust>,
) -> Result<Session, String> {
    if !interfaces().contains(&ip) || ip.parse::<Ipv4Addr>().is_err() {
        return Err("Select a local IPv4 interface".into());
    }
    let fingerprint = identity.fingerprint()?;
    let acceptor = identity.acceptor()?;
    let listener = TcpListener::bind((ip.as_str(), 0))
        .await
        .map_err(|e| e.to_string())?;
    let invitation = Invitation {
        v: 1,
        session_id: random_hex(16),
        token: random_hex(32),
        fingerprint,
        url: format!(
            "wss://{}:{}/",
            ip,
            listener.local_addr().map_err(|e| e.to_string())?.port()
        ),
        expires_at: now_ms() + 120_000,
    };
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Signal>(64);
    let (cancel, mut cancelled) = watch::channel(false);
    let bootstrap = TcpListener::bind((ip.as_str(), 0))
        .await
        .map_err(|e| e.to_string())?;
    let pairing_address = format!(
        "{}:{}",
        ip,
        bootstrap.local_addr().map_err(|e| e.to_string())?.port()
    );
    let (pairing_replies, replies) = mpsc::channel(4);
    let (claimed, claim_watch) = watch::channel(false);
    pairing::spawn(
        bootstrap,
        invitation.clone(),
        emit.clone(),
        cancelled.clone(),
        claim_watch,
        replies,
    );
    let info = invitation.clone();
    let (trust_tx, mut trust_rx) = mpsc::channel::<String>(4);
    tokio::spawn(async move {
        let state = |s: &str| {
            emit(Event::State {
                session_id: info.session_id.clone(),
                state: s.into(),
            })
        };
        let result: Result<(), String> = async {
            let mut attempts = 0;
            let mut websocket = loop {
                if attempts >= 8 || now_ms() >= info.expires_at { return Err("Invitation expired or attempt limit reached".into()); }
                let remaining = Duration::from_millis(info.expires_at.saturating_sub(now_ms()));
                let (tcp, _) = tokio::select! {
                    _ = cancelled.changed() => return Ok(()),
                    _ = sleep(remaining) => return Err("Invitation expired".into()),
                    connection = listener.accept() => connection.map_err(|e| e.to_string())?,
                };
                attempts += 1;
                let connect = async {
                    let tls = acceptor.accept(tcp).await.map_err(|_| "TLS handshake failed")?;
                    let config = WebSocketConfig::default().max_message_size(Some(MAX_BYTES)).max_frame_size(Some(MAX_BYTES));
                    let mut ws = accept_async_with_config(tls, Some(config)).await.map_err(|_| "WebSocket handshake failed")?;
                    let text = ws.next().await.ok_or("Closed")?.map_err(|_| "Read failed")?.into_text().map_err(|_| "Expected text")?;
                    let signal = parse(&text, &info.session_id)?;
                    if !valid_pair(&signal, &info, now_ms()) { return Err("Pairing rejected".to_string()); }
                    Ok(ws)
                };
                let accepted = tokio::select! { _ = cancelled.changed() => return Ok(()), result = timeout(Duration::from_secs(5), connect) => result };
                if let Ok(Ok(ws)) = accepted { break ws; }
            };
            // Consume the invitation by closing the listener after the first authenticated peer.
            drop(listener);
            let _ = claimed.send(true);
            websocket.send(Message::text(serde_json::to_string(&Signal { v: 1, session_id: info.session_id.clone(), payload: Payload::Paired }).unwrap())).await.map_err(|e| e.to_string())?;
            state("ready");
            let mut trust_tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => {
                        let stop = Signal { v: 1, session_id: info.session_id.clone(), payload: Payload::Stop };
                        let _ = timeout(Duration::from_secs(1), websocket.send(Message::text(serde_json::to_string(&stop).unwrap()))).await;
                        break;
                    },
                    message = outgoing_rx.recv() => {
                        let Some(message) = message else { break };
                        let stop = matches!(message.payload, Payload::Stop);
                        timeout(Duration::from_secs(5), websocket.send(Message::text(serde_json::to_string(&message).unwrap()))).await.map_err(|_| "Send timeout")?.map_err(|e| e.to_string())?;
                        if stop { break; }
                    },
                    _ = trust_tick.tick(), if trust.is_some() => {
                        if let Some(trust) = &trust { trust.expire_pending(); }
                    },
                    reply = trust_rx.recv(), if trust.is_some() => {
                        if let Some(reply) = reply {
                            timeout(Duration::from_secs(5), websocket.send(Message::text(reply))).await.map_err(|_| "Send timeout")?.map_err(|e| e.to_string())?;
                        }
                    },
                    incoming = websocket.next() => {
                        let Some(incoming) = incoming else { break };
                        match incoming.map_err(|e| e.to_string())? {
                            Message::Text(text) => {
                                if let Some(trust) = &trust
                                    && trust.enroll(&text, &info.session_id, &trust_tx, &emit)? { continue; }
                                let signal = parse(&text, &info.session_id)?;
                                if !matches!(signal.payload, Payload::Offer { .. } | Payload::Candidate { .. } | Payload::Stop) { return Err("Unexpected sender message".into()); }
                                let stop = matches!(signal.payload, Payload::Stop);
                                emit(Event::Signal { signal });
                                if stop { break; }
                            },
                            Message::Close(_) => break,
                            Message::Ping(data) => { timeout(Duration::from_secs(5), websocket.send(Message::Pong(data))).await.map_err(|_| "Pong timeout")?.map_err(|e| e.to_string())?; },
                            _ => return Err("Expected text message".into()),
                        }
                    }
                }
            }
            Ok(())
        }.await;
        if let Some(trust) = &trust {
            trust.clear_session(&info.session_id);
        }
        state(if result.is_ok() { "stopped" } else { "failed" });
    });
    Ok(Session {
        invitation,
        pairing_address,
        pairing_replies,
        outgoing,
        cancel,
        #[cfg(test)]
        certificate: identity.certificate()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_stale_and_extra_fields() {
        assert!(parse(r#"{"v":1,"sessionId":"old","type":"stop"}"#, "new").is_err());
        assert!(
            parse(
                r#"{"v":1,"sessionId":"a","type":"stop","token":"secret"}"#,
                "a"
            )
            .is_err()
        );
        assert!(parse(r#"{"v":1,"sessionId":"a","type":"stop"}"#, "a").is_ok());
    }
    #[tokio::test]
    async fn rejects_nonlocal_binding() {
        assert!(start("203.0.113.1".into(), Arc::new(|_| {})).await.is_err());
    }

    #[test]
    fn pairing_rejects_expiry_and_stale_session() {
        let info = Invitation {
            v: 1,
            session_id: "session".into(),
            token: "secret".into(),
            url: "unused".into(),
            fingerprint: "unused".into(),
            expires_at: 1000,
        };
        let mut signal = Signal {
            v: 1,
            session_id: "session".into(),
            payload: Payload::Pair {
                token: "secret".into(),
            },
        };
        assert!(valid_pair(&signal, &info, 999));
        assert!(!valid_pair(&signal, &info, 1000));
        signal.session_id = "old".into();
        assert!(!valid_pair(&signal, &info, 999));
    }

    async fn connect(
        session: &Session,
    ) -> tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>
    {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(session.certificate.clone()).unwrap();
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let address = session
            .invitation
            .url
            .trim_start_matches("wss://")
            .trim_end_matches('/');
        let ip = address
            .split(':')
            .next()
            .unwrap()
            .parse::<Ipv4Addr>()
            .unwrap();
        let tcp = tokio::net::TcpStream::connect(address).await.unwrap();
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(
                rustls::pki_types::ServerName::IpAddress(IpAddr::V4(ip).into()),
                tcp,
            )
            .await
            .unwrap();
        tokio_tungstenite::client_async(&session.invitation.url, tls)
            .await
            .unwrap()
            .0
    }

    #[tokio::test]
    async fn authenticates_once_forwards_messages_and_stops() {
        let Some(ip) = interfaces().first().cloned() else {
            return;
        };
        let (events, mut received) = mpsc::unbounded_channel();
        let session = start(
            ip,
            Arc::new(move |event| {
                let _ = events.send(event);
            }),
        )
        .await
        .unwrap();
        let info = session.invitation.clone();
        let mut rejected = connect(&session).await;
        rejected
            .send(Message::text(
                serde_json::to_string(&Signal {
                    v: 1,
                    session_id: info.session_id.clone(),
                    payload: Payload::Pair {
                        token: "wrong".into(),
                    },
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        // Invalid authentication closes this connection without consuming the valid invitation.
        let rejected_result = timeout(Duration::from_secs(2), rejected.next())
            .await
            .unwrap();
        assert!(rejected_result.is_none() || rejected_result.unwrap().is_err());
        let mut ws = connect(&session).await;
        ws.send(Message::text(
            serde_json::to_string(&Signal {
                v: 1,
                session_id: info.session_id.clone(),
                payload: Payload::Pair {
                    token: info.token.clone(),
                },
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        let paired = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert!(matches!(
            parse(&paired, &info.session_id).unwrap().payload,
            Payload::Paired
        ));
        assert_eq!(
            hex(&Sha256::digest(session.certificate.as_ref())),
            info.fingerprint
        );
        let address = info.url.trim_start_matches("wss://").trim_end_matches('/');
        assert!(
            tokio::net::TcpStream::connect(address).await.is_err(),
            "A consumed invitation must not accept another connection"
        );
        let offer = Signal {
            v: 1,
            session_id: info.session_id.clone(),
            payload: Payload::Offer {
                sdp: "v=0\r\n".into(),
            },
        };
        ws.send(Message::text(serde_json::to_string(&offer).unwrap()))
            .await
            .unwrap();
        loop {
            if let Event::Signal { signal } = timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap()
                .unwrap()
            {
                assert!(matches!(signal.payload, Payload::Offer { .. }));
                break;
            }
        }
        session
            .send(Signal {
                v: 1,
                session_id: info.session_id.clone(),
                payload: Payload::Answer {
                    sdp: "answer".into(),
                },
            })
            .unwrap();
        let answer = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert!(matches!(
            parse(&answer, &info.session_id).unwrap().payload,
            Payload::Answer { .. }
        ));
        drop(session);
        let stop = timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert!(matches!(
            parse(&stop, &info.session_id).unwrap().payload,
            Payload::Stop
        ));
    }
}
