//! The remembered endpoint: a LAN TLS WebSocket whose certificate key is this install's identity,
//! so a phone pins the public key, not a certificate or address. The phone then answers a fresh
//! challenge with its own key. An authenticated link only waits; it grants no stream by itself.
use super::{Trust, crypto};
use crate::Direction;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    net::Ipv4Addr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc, watch},
    time::{interval_at, timeout},
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub const MAX_BYTES: usize = 4096;
const HANDSHAKES: usize = 4;
const ATTEMPTS_PER_MINUTE: u32 = 30;
const AUTH_DEADLINE: Duration = Duration::from_secs(10);
const HEARTBEAT: Duration = Duration::from_secs(10);
const SILENCE: Duration = Duration::from_secs(30);

pub enum Incoming {
    Request {
        request_id: String,
        direction: Direction,
    },
    Accept(String),
    Reject(String),
    Cancel(String),
    Forget,
}

pub fn encode_connect(request_id: &str, direction: Direction) -> String {
    json!({"v": 1, "type": "connect_request", "requestId": request_id, "direction": direction})
        .to_string()
}

pub fn encode_request(kind: &str, request_id: &str) -> String {
    json!({"v": 1, "type": kind, "requestId": request_id}).to_string()
}

pub fn encode_invitation(request_id: &str, invitation: &str) -> String {
    json!({"v": 1, "type": "invitation", "requestId": request_id, "invitation": invitation})
        .to_string()
}

fn exact<'a>(
    value: &'a Value,
    kind: &str,
    fields: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == fields.len() + 2
        && object.get("v").and_then(Value::as_u64) == Some(1)
        && object.get("type").and_then(Value::as_str) == Some(kind)
        && fields
            .iter()
            .all(|f| object.get(*f).is_some_and(Value::is_string)))
    .then_some(object)
}

fn request_id(text: &str) -> bool {
    text.len() == 32 && crypto::unhex(text).is_some()
}

/// Strict parse of a phone message after authentication. Mirrors `parseLinkMessage(…, "phone")`.
pub fn parse(text: &str) -> Result<Incoming, String> {
    if text.len() > MAX_BYTES {
        return Err("Too large".into());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| "Invalid JSON")?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = |fields: &[&str]| {
        exact(&value, kind, fields)
            .and_then(|o| o.get("requestId")?.as_str().map(str::to_string))
            .filter(|id| request_id(id))
            .ok_or("Invalid link message")
    };
    Ok(match kind {
        "connect_request" => {
            let id = id(&["requestId", "direction"])?;
            let direction = serde_json::from_value(value["direction"].clone())
                .map_err(|_| "Invalid direction")?;
            Incoming::Request {
                request_id: id,
                direction,
            }
        }
        "connect_accept" => Incoming::Accept(id(&["requestId"])?),
        "connect_reject" => Incoming::Reject(id(&["requestId"])?),
        "connect_cancel" => Incoming::Cancel(id(&["requestId"])?),
        "forget" if exact(&value, kind, &[]).is_some() => Incoming::Forget,
        _ => return Err("Invalid link message".into()),
    })
}

fn parse_auth(text: &str) -> Option<(String, String, String)> {
    if text.len() > MAX_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    let o = exact(&value, "auth", &["key", "nonce", "signature"])?;
    let s = |f: &str| o[f].as_str().unwrap().to_string();
    (crypto::is_public_key(&s("key"))
        && crypto::is_nonce(&s("nonce"))
        && crypto::is_signature(&s("signature")))
    .then(|| (s("key"), s("nonce"), s("signature")))
}

fn acceptor(trust: &Trust, ip: Ipv4Addr) -> Result<TlsAcceptor, String> {
    let s = trust.lock();
    let identity = s
        .identity
        .as_ref()
        .ok_or("Remembered devices are unavailable.")?;
    let key = rcgen::KeyPair::try_from(identity.pkcs8())
        .map_err(|_| "Device identity cannot sign certificates")?;
    let cert = rcgen::CertificateParams::new(vec![ip.to_string()])
        .and_then(|p| p.self_signed(&key))
        .map_err(|_| "Could not create the remembered-device certificate")?;
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            rustls::pki_types::PrivateKeyDer::Pkcs8(identity.pkcs8().to_vec().into()),
        )
        .map_err(|e| e.to_string())?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Binds the saved port if it is free, otherwise a new one. Returns the port and a stop switch.
pub fn listen(
    trust: Arc<Trust>,
    ip: Ipv4Addr,
    port: u16,
) -> Result<(u16, watch::Sender<bool>), String> {
    let acceptor = acceptor(&trust, ip)?;
    let std = std::net::TcpListener::bind((ip, port))
        .or_else(|_| std::net::TcpListener::bind((ip, 0)))
        .map_err(|_| format!("Could not listen on {ip}. Check the network, then try again."))?;
    std.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = std.local_addr().map_err(|e| e.to_string())?.port();
    let (cancel, mut cancelled) = watch::channel(false);
    let runtime = trust.runtime.clone();
    runtime.spawn(async move {
        let Ok(listener) = TcpListener::from_std(std) else {
            return;
        };
        let permits = Arc::new(Semaphore::new(HANDSHAKES));
        let mut window = (Instant::now(), 0u32);
        loop {
            let accepted = tokio::select! {
                _ = cancelled.changed() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((tcp, _)) = accepted else { continue };
            if window.0.elapsed() > Duration::from_secs(60) {
                window = (Instant::now(), 0);
            }
            window.1 += 1;
            // Excess or concurrent unauthenticated sockets are closed before any TLS work.
            if window.1 > ATTEMPTS_PER_MINUTE {
                continue;
            }
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            tokio::spawn(serve(
                trust.clone(),
                acceptor.clone(),
                tcp,
                permit,
                cancelled.clone(),
            ));
        }
    });
    Ok((port, cancel))
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>;

async fn authenticate(
    trust: &Trust,
    acceptor: TlsAcceptor,
    tcp: tokio::net::TcpStream,
) -> Option<(Socket, String)> {
    let tls = acceptor.accept(tcp).await.ok()?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_BYTES))
        .max_frame_size(Some(MAX_BYTES));
    let mut ws = accept_async_with_config(tls, Some(config)).await.ok()?;
    let server_nonce = crypto::nonce();
    ws.send(Message::text(
        json!({"v": 1, "type": "challenge", "nonce": server_nonce}).to_string(),
    ))
    .await
    .ok()?;
    let text = loop {
        match ws.next().await?.ok()? {
            Message::Text(text) => break text,
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => return None,
        }
    };
    let (key, client_nonce, signature) = parse_auth(&text)?;
    let device = trust.authenticate(&key, &server_nonce, &client_nonce, &signature)?;
    Some((ws, device))
}

async fn serve(
    trust: Arc<Trust>,
    acceptor: TlsAcceptor,
    tcp: tokio::net::TcpStream,
    permit: tokio::sync::OwnedSemaphorePermit,
    mut endpoint: watch::Receiver<bool>,
) {
    let authenticated = tokio::select! {
        _ = endpoint.changed() => None,
        result = timeout(AUTH_DEADLINE, authenticate(&trust, acceptor, tcp)) => result.ok().flatten(),
    };
    drop(permit);
    // Failures close without detail, so an unknown phone learns nothing about records.
    let Some((mut ws, device)) = authenticated else {
        return;
    };
    let (out, mut outgoing) = mpsc::channel::<String>(16);
    let (cancel, mut cancelled) = watch::channel(false);
    let Some(generation) = trust.link_opened(&device, out, cancel) else {
        let _ = ws.close(None).await;
        return;
    };
    let mut heartbeat = interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut heard = tokio::time::Instant::now();
    let result: Result<(), ()> = async {
        timeout(Duration::from_secs(5), ws.send(Message::text(r#"{"v":1,"type":"authenticated"}"#))).await.map_err(|_| ())?.map_err(|_| ())?;
        loop {
            tokio::select! {
                biased;
                message = outgoing.recv() => {
                    let Some(message) = message else { return Ok(()) };
                    timeout(Duration::from_secs(5), ws.send(Message::text(message))).await.map_err(|_| ())?.map_err(|_| ())?;
                }
                _ = cancelled.changed() => return Ok(()),
                _ = endpoint.changed() => return Ok(()),
                _ = heartbeat.tick() => {
                    if heard.elapsed() >= SILENCE { return Err(()); }
                    timeout(Duration::from_secs(5), ws.send(Message::Ping(Vec::new().into()))).await.map_err(|_| ())?.map_err(|_| ())?;
                }
                incoming = ws.next() => {
                    heard = tokio::time::Instant::now();
                    match incoming.ok_or(())?.map_err(|_| ())? {
                        Message::Text(text) => {
                            let message = parse(&text).map_err(|_| ())?;
                            let (trust, device) = (trust.clone(), device.clone());
                            tokio::task::spawn_blocking(move || trust.on_link(&device, generation, message)).await.map_err(|_| ())?;
                        }
                        Message::Ping(data) => { let _ = timeout(Duration::from_secs(5), ws.send(Message::Pong(data))).await; }
                        Message::Pong(_) => {}
                        _ => return Err(()),
                    }
                }
            }
        }
    }
    .await;
    let _ = result;
    let _ = timeout(Duration::from_secs(1), ws.close(None)).await;
    trust.link_closed(&device, generation);
}
