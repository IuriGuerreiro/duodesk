use duodesk_signaling::host::Host;
use duodesk_signaling::{Direction, Signal};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
struct Remembered(tokio::sync::Mutex<Option<Host>>);

#[tauri::command]
fn stream_interfaces() -> Result<Vec<duodesk_signaling::NetworkAddress>, String> {
    duodesk_signaling::network_addresses()
}

async fn host_command(
    method: &str,
    args: serde_json::Value,
    app: tauri::AppHandle,
    state: State<'_, Remembered>,
) -> Result<serde_json::Value, String> {
    let mut host = state.0.lock().await;
    if host.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not locate app data")?;
        let emitter = app.clone();
        *host = Some(
            Host::open(
                dir,
                Arc::new(move |event| {
                    let _ = emitter.emit("stream-event", event);
                }),
            )
            .await,
        );
    }
    host.as_mut()
        .ok_or("Host unavailable")?
        .command(method, args)
        .await
}
#[tauri::command]
async fn stream_start(
    ip: String,
    direction: Direction,
    app: tauri::AppHandle,
    state: State<'_, Remembered>,
) -> Result<serde_json::Value, String> {
    host_command(
        "stream_start",
        serde_json::json!({"ip":ip,"direction":direction}),
        app,
        state,
    )
    .await
}
#[tauri::command]
async fn stream_stop(
    app: tauri::AppHandle,
    state: State<'_, Remembered>,
) -> Result<serde_json::Value, String> {
    host_command("stream_stop", serde_json::Value::Null, app, state).await
}
#[tauri::command]
async fn stream_send(
    signal: Signal,
    app: tauri::AppHandle,
    state: State<'_, Remembered>,
) -> Result<serde_json::Value, String> {
    host_command(
        "stream_send",
        serde_json::json!({"signal":signal}),
        app,
        state,
    )
    .await
}
#[tauri::command]
async fn stream_pair_reply(
    reply: serde_json::Value,
    app: tauri::AppHandle,
    state: State<'_, Remembered>,
) -> Result<serde_json::Value, String> {
    host_command(
        "stream_pair_reply",
        serde_json::json!({"reply":reply}),
        app,
        state,
    )
    .await
}

#[tauri::command]
async fn trust_command(
    method: String,
    args: serde_json::Value,
    app: tauri::AppHandle,
    state: State<'_, Remembered>,
) -> Result<serde_json::Value, String> {
    if !method.starts_with("trust_") {
        return Err("Invalid trust command".into());
    }
    host_command(&method, args, app, state).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Remembered(tokio::sync::Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            trust_command,
            stream_interfaces,
            stream_start,
            stream_send,
            stream_pair_reply,
            stream_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running DuoDesk");
}
