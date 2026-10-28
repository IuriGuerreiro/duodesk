//! The native authority shared by Electron's sidecar and Tauri.
use crate::{
    Direction, Event, Session, Signal, StartOptions,
    trust::{self, Trust},
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

pub struct Host {
    session: Option<Session>,
    trust: Arc<Trust>,
    pending: Option<(String, trust::Approved)>,
    emit: trust::Emit,
}
struct Unavailable(String);
impl trust::store::SecretStore for Unavailable {
    fn get(&self, _: &str) -> Result<Option<Vec<u8>>, String> {
        Err(self.0.clone())
    }
    fn set(&self, _: &str, _: &[u8]) -> Result<(), String> {
        Err(self.0.clone())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err(self.0.clone())
    }
}
impl Host {
    pub async fn open(dir: PathBuf, emit: Arc<dyn Fn(Event) + Send + Sync>) -> Self {
        let runtime = tokio::runtime::Handle::current();
        let (out, task_dir, task_runtime) = (emit.clone(), dir.clone(), runtime.clone());
        let task = tokio::task::spawn_blocking(move || {
            let store: Arc<dyn trust::store::SecretStore> = match trust::store::KeyringStore::open()
            {
                Ok(s) => Arc::new(s),
                Err(e) => Arc::new(Unavailable(e)),
            };
            // Timed-out initialization must never start an orphaned listener after an OS prompt.
            Trust::load_only(task_dir, store, out, task_runtime)
        });
        let trust = match tokio::time::timeout(std::time::Duration::from_secs(3), task).await {
            Ok(Ok(trust)) => trust,
            _ => Trust::load_only(dir, Arc::new(Unavailable("Secure storage did not respond. Unlock your login keyring and restart DuoDesk. Code pairing is still available.".into())), emit.clone(), runtime),
        };
        trust.activate();
        Self {
            session: None,
            trust,
            pending: None,
            emit,
        }
    }

    #[cfg(feature = "test-storage")]
    pub async fn open_for_test(dir: PathBuf, file: PathBuf, emit: trust::Emit) -> Self {
        let runtime = tokio::runtime::Handle::current();
        let out = emit.clone();
        let trust = tokio::task::spawn_blocking(move || {
            Trust::open(
                dir,
                Arc::new(trust::store::testing::FileStore(file)),
                out,
                runtime,
            )
        })
        .await
        .expect("test storage task");
        Self {
            session: None,
            trust,
            pending: None,
            emit,
        }
    }

    fn stop_session(&mut self) {
        if let Some((request_id, _)) = self.pending.take() {
            let _ = self.trust.cancel_request(&request_id);
        }
        self.session.take();
    }

    pub async fn command(&mut self, method: &str, args: Value) -> Result<Value, String> {
        let text = |key: &str| {
            args[key]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("Missing {key}"))
        };
        let direction = || {
            serde_json::from_value::<Direction>(args["direction"].clone())
                .map_err(|_| "Invalid direction".to_string())
        };
        match method {
            "stream_interfaces" => Ok(json!(crate::network_addresses()?)),
            "stream_stop" => {
                self.stop_session();
                Ok(Value::Null)
            }
            "stream_start" => {
                self.stop_session();
                let next = crate::start_with(
                    text("ip")?,
                    direction()?,
                    self.emit.clone(),
                    StartOptions {
                        bootstrap: true,
                        trust: Some(self.trust.clone()),
                    },
                )
                .await?;
                let result = json!({"invitation":next.invitation,"address":next.pairing_address});
                self.session = Some(next);
                Ok(result)
            }
            "stream_pair_reply" => {
                let reply = serde_json::from_value(args["reply"].clone())
                    .map_err(|_| "Invalid pairing reply")?;
                self.session
                    .as_ref()
                    .ok_or("No session")?
                    .pair_reply(reply)?;
                Ok(Value::Null)
            }
            "stream_send" => {
                let signal: Signal =
                    serde_json::from_value(args["signal"].clone()).map_err(|_| "Invalid signal")?;
                self.session.as_ref().ok_or("No session")?.send(signal)?;
                Ok(Value::Null)
            }
            "trust_start" => {
                // Only an already-approved, unexpired, single-use request can create a stream.
                let approved = self.trust.take_approved(&text("requestId")?)?;
                self.stop_session();
                let next = crate::start_with(
                    approved.ip.clone(),
                    approved.direction,
                    self.emit.clone(),
                    StartOptions {
                        bootstrap: false,
                        trust: Some(self.trust.clone()),
                    },
                )
                .await?;
                self.pending = Some((text("requestId")?, approved));
                let result = json!({"invitation":next.invitation,"address":""});
                self.session = Some(next);
                Ok(result)
            }
            "trust_ready" => {
                let id = text("requestId")?;
                if self
                    .pending
                    .as_ref()
                    .is_none_or(|(request, _)| request != &id)
                {
                    return Err("Stale session request".into());
                }
                let (_, approved) = self.pending.take().ok_or("No session request")?;
                let session = self.session.as_ref().ok_or("No session")?;
                self.trust
                    .deliver(&approved, &session.invitation, session.canceller())?;
                Ok(Value::Null)
            }
            _ => {
                let (trust, method) = (self.trust.clone(), method.to_string());
                tokio::task::spawn_blocking(move || {
                    let text =
                        |key: &str| args[key].as_str().ok_or_else(|| format!("Missing {key}"));
                    match method.as_str() {
                        "trust_status" => return Ok(json!(trust.status())),
                        "trust_rename" => trust.rename(text("deviceId")?, text("name")?)?,
                        "trust_forget" => trust.forget(text("deviceId")?)?,
                        "trust_endpoint" => trust.set_endpoint(args["ip"].as_str())?,
                        "trust_enroll" => trust.enroll_command(
                            text("action")?,
                            args["name"].as_str().map(str::to_string),
                        )?,
                        "trust_connect" => {
                            let direction = serde_json::from_value(args["direction"].clone())
                                .map_err(|_| "Invalid direction")?;
                            return Ok(json!(trust.connect(text("deviceId")?, direction)?));
                        }
                        "trust_respond" => {
                            trust.respond(
                                text("requestId")?,
                                args["accept"].as_bool().ok_or("Missing accept")?,
                            )?;
                        }
                        "trust_cancel" => trust.cancel_request(text("requestId")?)?,
                        _ => return Err("Unknown method".into()),
                    }
                    Ok(Value::Null)
                })
                .await
                .map_err(|_| "Native command failed")?
            }
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.trust.shutdown();
    }
}
