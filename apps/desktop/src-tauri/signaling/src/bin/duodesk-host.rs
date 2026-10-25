//! Private bounded JSON-lines transport. stdout is protocol only; EOF drops the session.
use duodesk_signaling::{
    Direction, Event, Identity, Session, Signal,
    trust::{Listener, Reconnect, Trust},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    sync::Arc,
};
fn output(value: Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
#[tokio::main]
async fn main() {
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut bytes = Vec::new();
            // take() prevents a hostile or broken parent from allocating unbounded lines.
            use std::io::Read;
            match input.by_ref().take(70_000).read_until(b'\n', &mut bytes) {
                Ok(0) | Err(_) => break,
                _ if bytes.last() != Some(&b'\n') => break,
                _ => {
                    if tx.blocking_send(bytes).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(|event| output(json!({"event": event})));
    let mut session: Option<Session> = None;
    let mut trust: Option<Trust> = None;
    let mut listener: Option<Listener> = None;
    let mut trusted_ip: Option<String> = None;
    let (handoffs, mut reconnects) = tokio::sync::mpsc::channel::<Reconnect>(4);
    loop {
        let bytes = tokio::select! {
            biased;
            bytes = rx.recv() => match bytes { Some(bytes) => bytes, None => break },
            Some(reconnect) = reconnects.recv() => {
                let result = async {
                    let trust = trust.as_ref().ok_or("Trust unavailable")?;
                    if !trust.accepts(&reconnect) { return Err("Revoked or disabled".into()); }
                    let next = duodesk_signaling::start_with_identity(
                        trusted_ip.clone().ok_or("Listener disabled")?, Direction::PhoneToDesktop, emit.clone(), trust.identity.clone(), Some(trust.clone())
                    ).await?;
                    if !trust.accepts(&reconnect) { return Err("Revoked or disabled".into()); }
                    let invitation = next.invitation.clone();
                    session = Some(next);
                    emit(Event::TrustReconnected { phone_id: reconnect.phone.phone_id.clone(), invitation: invitation.clone() });
                    Ok(invitation)
                }.await;
                let _ = reconnect.reply.send(result);
                continue;
            }
        };
        let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let Some(id) = request["id"].as_u64() else {
            break;
        };
        let result: Result<Value, String> = async {
            match request["method"].as_str() {
                Some("identity_generate") => Ok(json!(Identity::generate()?)),
                Some("trust_configure") => {
                    if trust.is_some() {
                        return Err("Trust already configured".into());
                    }
                    let identity: Identity =
                        serde_json::from_value(request["args"]["identity"].clone())
                            .map_err(|_| "Invalid identity")?;
                    let phones = serde_json::from_value(request["args"]["devices"].clone())
                        .map_err(|_| "Invalid devices")?;
                    let address = request["args"]["address"]
                        .as_str()
                        .ok_or("Missing address")?;
                    trust = Some(Trust::new(identity, phones, address.into(), emit.clone())?);
                    Ok(Value::Null)
                }
                Some("trust_pending") => {
                    Ok(json!(trust.as_ref().ok_or("Trust unavailable")?.pending()))
                }
                Some("trust_pending_phone") => {
                    let id = request["args"]["requestId"]
                        .as_str()
                        .ok_or("Missing request")?;
                    Ok(json!(
                        trust
                            .as_ref()
                            .ok_or("Trust unavailable")?
                            .pending_phone(id)?
                    ))
                }
                Some("trust_update") => {
                    let phones = serde_json::from_value(request["args"]["devices"].clone())
                        .map_err(|_| "Invalid devices")?;
                    trust.as_ref().ok_or("Trust unavailable")?.update(phones)?;
                    Ok(Value::Null)
                }
                Some("trust_decide") => {
                    let id = request["args"]["requestId"]
                        .as_str()
                        .ok_or("Missing request")?;
                    let approve = request["args"]["approve"]
                        .as_bool()
                        .ok_or("Missing decision")?;
                    trust
                        .as_ref()
                        .ok_or("Trust unavailable")?
                        .decide(id, approve)?;
                    Ok(Value::Null)
                }
                Some("trust_allow") => {
                    listener.take();
                    trusted_ip.take();
                    let trust = trust.as_ref().ok_or("Trust unavailable")?;
                    trust.disable();
                    if request["args"]["allow"].as_bool().ok_or("Missing allow")? {
                        let ip = request["args"]["ip"].as_str().ok_or("Missing IP")?;
                        let port = request["args"]["port"]
                            .as_u64()
                            .and_then(|p| u16::try_from(p).ok())
                            .ok_or("Invalid port")?;
                        let next = trust.listen(ip, port, handoffs.clone()).await?;
                        let address = next.address.clone();
                        trusted_ip = Some(ip.into());
                        listener = Some(next);
                        Ok(json!({"address":address}))
                    } else {
                        Ok(Value::Null)
                    }
                }
                Some("stream_interfaces") => Ok(json!(duodesk_signaling::network_addresses()?)),
                Some("stream_stop") => {
                    session.take();
                    Ok(Value::Null)
                }
                Some("stream_start") => {
                    session.take();
                    let ip = request["args"]["ip"].as_str().ok_or("Missing IP")?;
                    let direction: Direction =
                        serde_json::from_value(request["args"]["direction"].clone())
                            .map_err(|_| "Invalid direction")?;
                    let next = if let Some(trust) = &trust {
                        duodesk_signaling::start_with_identity(
                            ip.into(),
                            direction,
                            emit.clone(),
                            trust.identity.clone(),
                            Some(trust.clone()),
                        )
                        .await?
                    } else {
                        duodesk_signaling::start(ip.into(), direction, emit.clone()).await?
                    };
                    let invitation =
                        json!({"invitation": next.invitation, "address": next.pairing_address});
                    session = Some(next);
                    Ok(invitation)
                }
                Some("stream_pair_reply") => {
                    let reply = serde_json::from_value(request["args"]["reply"].clone())
                        .map_err(|_| "Invalid pairing reply")?;
                    session.as_ref().ok_or("No session")?.pair_reply(reply)?;
                    Ok(Value::Null)
                }
                Some("stream_send") => {
                    let signal: Signal = serde_json::from_value(request["args"]["signal"].clone())
                        .map_err(|_| "Invalid signal")?;
                    session.as_ref().ok_or("No session")?.send(signal)?;
                    Ok(Value::Null)
                }
                _ => Err("Unknown method".into()),
            }
        }
        .await;
        match result {
            Ok(value) => output(json!({"id": id, "result": value})),
            Err(error) => output(json!({"id": id, "error": error})),
        }
    }
    listener.take();
    session.take();
}
