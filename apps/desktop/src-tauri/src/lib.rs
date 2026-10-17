use duodesk_signaling::{Invitation, Session, Signal};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
struct Receiver(Mutex<Option<Session>>);

#[tauri::command]
fn stream_interfaces() -> Vec<String> {
    duodesk_signaling::interfaces()
}

#[tauri::command]
async fn stream_start(
    ip: String,
    app: tauri::AppHandle,
    receiver: State<'_, Receiver>,
) -> Result<Invitation, String> {
    receiver
        .0
        .lock()
        .map_err(|_| "Receiver unavailable")?
        .take();
    let session = duodesk_signaling::start(
        ip,
        Arc::new(move |event| {
            let _ = app.emit("stream-event", event);
        }),
    )
    .await?;
    let invitation = session.invitation.clone();
    *receiver.0.lock().map_err(|_| "Receiver unavailable")? = Some(session);
    Ok(invitation)
}

#[tauri::command]
fn stream_send(signal: Signal, receiver: State<'_, Receiver>) -> Result<(), String> {
    receiver
        .0
        .lock()
        .map_err(|_| "Receiver unavailable")?
        .as_ref()
        .ok_or("No session")?
        .send(signal)
}

#[tauri::command]
fn stream_stop(receiver: State<'_, Receiver>) -> Result<(), String> {
    receiver
        .0
        .lock()
        .map_err(|_| "Receiver unavailable")?
        .take();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Receiver::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            stream_interfaces,
            stream_start,
            stream_send,
            stream_stop
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut receiver) = window.state::<Receiver>().0.lock() {
                    receiver.take();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DuoDesk");
}
