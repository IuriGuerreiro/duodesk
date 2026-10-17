//! Private bounded JSON-lines transport. stdout is protocol only; EOF drops the session.
use duodesk_signaling::{Session, Signal};
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
    let mut session: Option<Session> = None;
    while let Some(bytes) = rx.recv().await {
        let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let Some(id) = request["id"].as_u64() else {
            break;
        };
        let result: Result<Value, String> = async {
            match request["method"].as_str() {
                Some("stream_interfaces") => Ok(json!(duodesk_signaling::interfaces())),
                Some("stream_stop") => {
                    session.take();
                    Ok(Value::Null)
                }
                Some("stream_start") => {
                    session.take();
                    let ip = request["args"]["ip"].as_str().ok_or("Missing IP")?;
                    let next = duodesk_signaling::start(
                        ip.into(),
                        Arc::new(|event| output(json!({"event": event}))),
                    )
                    .await?;
                    let invitation = json!(next.invitation);
                    session = Some(next);
                    Ok(invitation)
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
    session.take();
}
