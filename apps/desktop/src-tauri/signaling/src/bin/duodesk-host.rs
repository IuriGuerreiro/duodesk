//! Private bounded JSON-lines transport. stdout is protocol only; EOF drops the session.
use duodesk_signaling::host::Host;
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
    let dir = std::env::var_os("DUODESK_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let base = std::env::var_os("APPDATA")
                .or_else(|| std::env::var_os("XDG_DATA_HOME"))
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                        .join(".local/share")
                });
            base.join("duodesk")
        });
    let emit: duodesk_signaling::trust::Emit = Arc::new(|event| output(json!({"event":event})));
    #[cfg(feature = "test-storage")]
    let mut host = if let Some(file) = std::env::var_os("DUODESK_TEST_SECRET_FILE") {
        Host::open_for_test(dir, file.into(), emit).await
    } else {
        Host::open(dir, emit).await
    };
    #[cfg(not(feature = "test-storage"))]
    let mut host = Host::open(dir, emit).await;
    while let Some(bytes) = rx.recv().await {
        let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let Some(id) = request["id"].as_u64() else {
            break;
        };
        let result = host
            .command(
                request["method"].as_str().unwrap_or(""),
                request["args"].clone(),
            )
            .await;
        match result {
            Ok(value) => output(json!({"id": id, "result": value})),
            Err(error) => output(json!({"id": id, "error": error})),
        }
    }
}
