//! Remembered devices: this install's identity, enrolled phones, the remembered LAN endpoint,
//! authenticated idle links and connect requests. See `docs/remembered-devices.md`.
//!
//! Three layers stay separate: names/addresses are display hints; trust is a phone key in secure
//! storage enrolled with approval on both devices; a stream still needs a request accepted locally.
pub mod crypto;
pub mod enroll;
pub mod link;
mod records;
mod requests;
pub mod store;

use crate::{Direction, Event, Invitation};
use crypto::Identity;
use enroll::{Enrollment, Msg};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::Ipv4Addr,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use store::{EndpointSetting, Metadata, PeerRecord, SecretStore, Status};
use tokio::sync::{mpsc, watch};

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const START_WINDOW: Duration = Duration::from_secs(30);
const ENROLL_TIMEOUT: Duration = Duration::from_secs(120);
// A complete peer blob, including a pending record, must fit Windows Credential Manager.
const MAX_DEVICES: usize = 8;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    /// The phone holds an authenticated idle link right now.
    pub available: bool,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatus {
    pub interface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub listening: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Name this PC suggests to phones. Display only.
    pub name: String,
    pub endpoint: Option<EndpointStatus>,
    pub devices: Vec<DeviceStatus>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TrustEvent {
    Status {
        status: TrustStatus,
    },
    Enroll {
        #[serde(rename = "sessionId")]
        session_id: String,
        state: String,
        #[serde(rename = "peerName", skip_serializing_if = "Option::is_none")]
        peer_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// The phone asked to start a stream. Nothing starts unless the local user accepts.
    Request {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        direction: Direction,
    },
    Accepted {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        direction: Direction,
    },
    Rejected {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Cancelled {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    /// The phone forgot this PC; its record here was removed too.
    Forgotten {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
}

/// The session socket an enrollment rides on. Registered by the session task after `paired`.
pub struct SessionLink {
    pub session_id: String,
    pub certificate_fingerprint: String,
    pub token: String,
    pub out: mpsc::Sender<String>,
    pub cancel: Arc<watch::Sender<bool>>,
}

struct Attached {
    out: mpsc::Sender<String>,
    cancel: Arc<watch::Sender<bool>>,
    enrollment: Enrollment,
}

pub(crate) struct LinkHandle {
    pub generation: u64,
    pub out: mpsc::Sender<String>,
    pub cancel: watch::Sender<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Origin {
    Local,
    Remote,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    AwaitingRemote,
    AwaitingLocal,
    Approved,
    Starting,
}

struct Request {
    device: String,
    direction: Direction,
    origin: Origin,
    phase: Phase,
    at: Instant,
    link: u64,
}

struct Endpoint {
    ip: Ipv4Addr,
    cancel: watch::Sender<bool>,
    advertisement: Option<crate::discovery::Advertisement>,
}

/// A started stream bound to a remembered phone, so Forget can end it.
struct Bound {
    request_id: Option<String>,
    session_id: String,
    device: String,
    cancel: Arc<watch::Sender<bool>>,
}

struct State {
    identity: Option<Identity>,
    error: Option<String>,
    meta: Metadata,
    peers: Vec<PeerRecord>,
    /// Forgotten keys: refused immediately, even before durable removal completes.
    revoked: Vec<String>,
    attached: Option<(String, Attached)>,
    links: HashMap<String, LinkHandle>,
    next_link: u64,
    requests: HashMap<String, Request>,
    endpoint: Option<Endpoint>,
    endpoint_error: Option<String>,
    bound: Option<Bound>,
}

pub struct Approved {
    pub device: String,
    pub direction: Direction,
    pub ip: String,
    request_id: String,
}

pub struct Trust {
    dir: PathBuf,
    store: Arc<dyn SecretStore>,
    emit: Emit,
    runtime: tokio::runtime::Handle,
    name: String,
    state: Mutex<State>,
    endpoint_config: Mutex<()>,
    closed: std::sync::atomic::AtomicBool,
}

fn now_ms() -> u64 {
    crate::now_ms()
}

fn secret_name(meta: &Metadata, kind: &str) -> String {
    format!("{kind}-{}", meta.install_id)
}

impl Trust {
    /// Loads identity and records. Storage failures leave trust unavailable with an actionable
    /// error; pairing with a code keeps working.
    pub fn open(
        dir: PathBuf,
        store: Arc<dyn SecretStore>,
        emit: Emit,
        runtime: tokio::runtime::Handle,
    ) -> Arc<Self> {
        let trust = Self::load_only(dir, store, emit, runtime);
        trust.activate();
        trust
    }

    pub(crate) fn load_only(
        dir: PathBuf,
        store: Arc<dyn SecretStore>,
        emit: Emit,
        runtime: tokio::runtime::Handle,
    ) -> Arc<Self> {
        let mut state = State {
            identity: None,
            error: None,
            meta: Metadata::default(),
            peers: vec![],
            revoked: vec![],
            attached: None,
            links: HashMap::new(),
            next_link: 0,
            requests: HashMap::new(),
            endpoint: None,
            endpoint_error: None,
            bound: None,
        };
        if let Err(error) = Self::load(&dir, store.as_ref(), &mut state) {
            state.identity = None;
            state.peers.clear();
            state.error = Some(error);
        }
        Arc::new(Self {
            dir,
            store,
            emit,
            runtime,
            name: crate::discovery::display_name(),
            state: Mutex::new(state),
            endpoint_config: Mutex::new(()),
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub(crate) fn activate(self: &Arc<Self>) {
        if !self.available() {
            return;
        }
        let setting = self.lock().meta.endpoint.clone();
        if let Some(setting) = setting
            && self.available()
        {
            self.restore_endpoint(&setting);
        }
        let weak = Arc::downgrade(self);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let Some(trust) = weak.upgrade() else { break };
                if trust.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                let _ = tokio::task::spawn_blocking(move || trust.refresh_endpoint()).await;
            }
        });
    }

    fn load(
        dir: &std::path::Path,
        store: &dyn SecretStore,
        state: &mut State,
    ) -> Result<(), String> {
        // A missing or unreadable marker means a new install: never adopt old secure-storage entries.
        let mut meta = store::read_metadata(dir).unwrap_or_else(|| Metadata {
            v: 1,
            install_id: crypto::nonce()[..32].to_string(),
            ..Default::default()
        });
        store::write_metadata(dir, &meta)?;
        let identity = match store.get(&secret_name(&meta, "identity"))? {
            Some(pkcs8) => Identity::from_pkcs8(&pkcs8)?,
            None => {
                // Key loss: any phone records refer to the old key and must pair again.
                let identity = Identity::generate()?;
                store.set(&secret_name(&meta, "trust"), &store::encode_peers(&[]))?;
                store.set(&secret_name(&meta, "identity"), identity.pkcs8())?;
                identity
            }
        };
        let stored = match store.get(&secret_name(&meta, "trust"))? {
            Some(bytes) => store::decode_peers(&bytes)?,
            None => vec![],
        };
        // Pending records never survive a restart; tombstoned keys are removed for good now.
        let peers: Vec<_> = stored
            .iter()
            .filter(|p| p.status == Status::Active && !meta.revoked.contains(&p.key))
            .cloned()
            .collect();
        if peers != stored {
            store.set(&secret_name(&meta, "trust"), &store::encode_peers(&peers))?;
        }
        if !meta.revoked.is_empty()
            || meta
                .names
                .keys()
                .any(|id| !peers.iter().any(|p| &p.id == id))
        {
            meta.revoked.clear();
            meta.names.retain(|id, _| peers.iter().any(|p| &p.id == id));
            store::write_metadata(dir, &meta)?;
        }
        state.identity = Some(identity);
        state.meta = meta;
        state.peers = peers;
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn available(&self) -> bool {
        self.lock().identity.is_some()
    }

    pub fn public_key(&self) -> Option<String> {
        self.lock().identity.as_ref().map(Identity::public_key)
    }

    fn snapshot(&self, s: &State) -> TrustStatus {
        TrustStatus {
            available: s.identity.is_some(),
            error: s.error.clone(),
            name: self.name.clone(),
            endpoint: s.meta.endpoint.as_ref().map(|e| EndpointStatus {
                interface: e.interface.clone(),
                address: s.endpoint.as_ref().map(|l| format!("{}:{}", l.ip, e.port)),
                listening: s.endpoint.is_some(),
                error: s.endpoint_error.clone(),
            }),
            devices: s
                .peers
                .iter()
                .filter(|p| p.status == Status::Active && !s.revoked.contains(&p.key))
                .map(|p| DeviceStatus {
                    id: p.id.clone(),
                    name: s
                        .meta
                        .names
                        .get(&p.id)
                        .cloned()
                        .unwrap_or_else(|| "Phone".into()),
                    created_at: p.created_at,
                    available: s.links.contains_key(&p.id),
                })
                .collect(),
        }
    }

    pub fn status(&self) -> TrustStatus {
        let s = self.lock();
        self.snapshot(&s)
    }

    fn publish(&self, s: &State) {
        (self.emit)(Event::Trust(TrustEvent::Status {
            status: self.snapshot(s),
        }));
    }

    fn event(&self, event: TrustEvent) {
        (self.emit)(Event::Trust(event));
    }

    fn require_identity(s: &State) -> Result<(), String> {
        if s.identity.is_some() {
            Ok(())
        } else {
            Err(s
                .error
                .clone()
                .unwrap_or_else(|| "Remembered devices are unavailable.".into()))
        }
    }

    fn save_peers(&self, s: &State, peers: &[PeerRecord]) -> Result<(), String> {
        self.store
            .set(&secret_name(&s.meta, "trust"), &store::encode_peers(peers))
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let mut s = self.lock();
        Self::require_identity(&s)?;
        let name = enroll::clean_name(name).ok_or("Enter a name.")?;
        if !s
            .peers
            .iter()
            .any(|p| p.id == id && p.status == Status::Active)
        {
            return Err("That device is no longer remembered.".into());
        }
        let mut meta = s.meta.clone();
        meta.names.insert(id.into(), name);
        store::write_metadata(&self.dir, &meta)?;
        s.meta = meta;
        self.publish(&s);
        Ok(())
    }

    /// Blocks the device at once, ends its link, requests and stream, then removes it durably.
    /// Reports success only once removal or a durable tombstone is written.
    pub fn forget(&self, id: &str) -> Result<(), String> {
        self.remove(id, true)
    }

    fn remove(&self, id: &str, notify: bool) -> Result<(), String> {
        let mut s = self.lock();
        let Some(record) = s.peers.iter().find(|p| p.id == id).cloned() else {
            return Err("That device is no longer remembered.".into());
        };
        if !s.revoked.contains(&record.key) {
            s.revoked.push(record.key.clone());
        }
        if let Some(link) = s.links.remove(id) {
            if notify {
                let _ = link.out.try_send(r#"{"v":1,"type":"forget"}"#.into());
            }
            // Give the forget notice a moment to flush before the link task closes the socket.
            let cancel = link.cancel;
            self.runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let _ = cancel.send(true);
            });
        }
        let requests: Vec<_> = s
            .requests
            .iter()
            .filter(|(_, r)| r.device == id)
            .map(|(id, _)| id.clone())
            .collect();
        for request_id in requests {
            s.requests.remove(&request_id);
            self.event(TrustEvent::Cancelled {
                request_id,
                device_id: id.into(),
            });
        }
        if s.bound.as_ref().is_some_and(|b| b.device == id)
            && let Some(bound) = s.bound.take()
        {
            let _ = bound.cancel.send(true);
        }
        let mut meta = s.meta.clone();
        meta.revoked.push(record.key.clone());
        let tombstone = store::write_metadata(&self.dir, &meta);
        let remaining: Vec<_> = s.peers.iter().filter(|p| p.id != id).cloned().collect();
        let removed = self.save_peers(&s, &remaining);
        let result = match (&removed, &tombstone) {
            (Ok(()), _) => {
                s.peers = remaining;
                meta.revoked.retain(|k| k != &record.key);
                meta.names.remove(id);
                let _ = store::write_metadata(&self.dir, &meta);
                s.meta = meta;
                Ok(())
            }
            (Err(_), Ok(())) => {
                // Blocked durably by the tombstone; secure storage is cleaned on the next launch.
                s.meta = meta;
                Ok(())
            }
            (Err(error), Err(_)) => Err(format!(
                "{error} The device is blocked until DuoDesk closes, but could not be removed for good. Try Forget again."
            )),
        };
        self.publish(&s);
        result
    }

    // ---- Enrollment on a paired session -------------------------------------------------------

    pub(crate) fn attach_session(&self, link: SessionLink) {
        let mut s = self.lock();
        if s.identity.is_none() {
            return;
        }
        if let Some((id, mut attached)) = s.attached.take() {
            let mut records = Records {
                trust: self,
                state: &mut s,
            };
            let outcome = attached.enrollment.abandon(&mut records);
            self.enroll_event(&id, &outcome);
        }
        let token = crypto::unhex(&link.token).unwrap_or_default();
        let enrollment = Enrollment::new(enroll::Context {
            session_id: link.session_id.clone(),
            certificate_fingerprint: link.certificate_fingerprint,
            token_hash: crypto::sha256_hex(&token),
        });
        s.attached = Some((
            link.session_id,
            Attached {
                out: link.out,
                cancel: link.cancel,
                enrollment,
            },
        ));
    }

    pub(crate) fn detach_session(&self, session_id: &str) {
        let mut s = self.lock();
        if s.attached.as_ref().is_some_and(|(id, _)| id == session_id)
            && let Some((_, mut attached)) = s.attached.take()
        {
            let outcome = {
                let mut records = Records {
                    trust: self,
                    state: &mut s,
                };
                attached.enrollment.abandon(&mut records)
            };
            if outcome.state.is_some() {
                self.enroll_event(session_id, &outcome);
            }
        }
        if s.bound.as_ref().is_some_and(|b| b.session_id == session_id) {
            s.bound = None;
        }
    }

    fn enroll_event(&self, session_id: &str, outcome: &enroll::Outcome) {
        if let Some(state) = outcome.state {
            self.event(TrustEvent::Enroll {
                session_id: session_id.into(),
                state: state.into(),
                peer_name: outcome.peer_name.clone(),
                message: outcome.message.clone(),
            });
        }
    }

    /// Runs one enrollment step with storage access, sends its messages, publishes its state.
    fn with_enrollment<T>(
        self: &Arc<Self>,
        session_id: Option<&str>,
        step: impl FnOnce(
            &mut Enrollment,
            &Identity,
            &mut Records,
        ) -> Result<(T, enroll::Outcome), String>,
    ) -> Result<T, String> {
        let mut s = self.lock();
        Self::require_identity(&s)?;
        let Some((id, mut attached)) = s.attached.take() else {
            return Err("Remember works during a paired session.".into());
        };
        if session_id.is_some_and(|sid| sid != id) {
            s.attached = Some((id, attached));
            return Err("Stale session".into());
        }
        let identity = s.identity.take().unwrap();
        let generation = attached.enrollment.generation;
        let result = {
            let mut records = Records {
                trust: self,
                state: &mut s,
            };
            step(&mut attached.enrollment, &identity, &mut records)
        };
        s.identity = Some(identity);
        let result = result.map(|(value, outcome)| {
            for msg in &outcome.send {
                let _ = attached.out.try_send(enroll::encode(&id, msg));
            }
            if let Some(device) = &outcome.activated {
                s.bound = Some(Bound {
                    request_id: None,
                    session_id: id.clone(),
                    device: device.clone(),
                    cancel: attached.cancel.clone(),
                });
                self.publish(&s);
            }
            self.enroll_event(&id, &outcome);
            value
        });
        if attached.enrollment.generation != generation {
            let (trust, sid, generation) =
                (self.clone(), id.clone(), attached.enrollment.generation);
            self.runtime.spawn(async move {
                tokio::time::sleep(ENROLL_TIMEOUT).await;
                let _ = tokio::task::spawn_blocking(move || trust.enroll_timeout(&sid, generation))
                    .await;
            });
        }
        s.attached = Some((id, attached));
        result
    }

    fn enroll_timeout(self: &Arc<Self>, session_id: &str, generation: u64) {
        let _ = self.with_enrollment(Some(session_id), |e, _, records| {
            let outcome = if e.generation == generation {
                e.abandon(records)
            } else {
                enroll::Outcome {
                    send: vec![],
                    state: None,
                    peer_name: None,
                    message: None,
                    activated: None,
                }
            };
            Ok(((), outcome))
        });
    }

    pub(crate) fn on_enroll(self: &Arc<Self>, session_id: &str, value: &serde_json::Value) {
        let _ = self.with_enrollment(Some(session_id), |e, identity, records| {
            let outcome = match enroll::parse(value, session_id) {
                Ok(msg) => e.receive(identity, msg, records),
                Err(_) => e.receive(identity, Msg::Cancel, records),
            };
            Ok(((), outcome))
        });
    }

    /// Local Remember / Approve / Decline for the current session.
    pub fn enroll_command(
        self: &Arc<Self>,
        action: &str,
        name: Option<String>,
    ) -> Result<(), String> {
        let name = match name {
            Some(n) if !n.trim().is_empty() => {
                Some(enroll::clean_name(&n).ok_or("Enter a valid name.")?)
            }
            _ => None,
        };
        let own = self.name.clone();
        self.with_enrollment(None, |e, identity, records| {
            let outcome = match action {
                "start" => e.start(identity, &own, name)?,
                "approve" => e.approve(identity, &own, name)?,
                "reject" => e.reject(records)?,
                "cancel" => e.abandon(records),
                _ => return Err("Unknown remember action".into()),
            };
            Ok(((), outcome))
        })
    }

    // ---- Remembered endpoint and links ---------------------------------------------------------

    /// Opt in on one interface (or `None` to stop). Only private or link-local LAN addresses.
    pub fn set_endpoint(self: &Arc<Self>, ip: Option<&str>) -> Result<(), String> {
        let _guard = self
            .endpoint_config
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Host closed".into());
        }
        {
            let s = self.lock();
            Self::require_identity(&s)?;
        }
        self.stop_endpoint();
        let mut s = self.lock();
        let mut meta = s.meta.clone();
        match ip {
            None => {
                meta.endpoint = None;
                store::write_metadata(&self.dir, &meta)?;
                s.meta = meta;
                s.endpoint_error = None;
            }
            Some(ip) => {
                let address = crate::network_addresses()?
                    .into_iter()
                    .find(|a| a.address == ip && remembered_ip(a))
                    .ok_or("Choose a Wi-Fi or Ethernet address on your local network. VPN addresses work with pairing codes only.")?;
                let port = s
                    .meta
                    .endpoint
                    .as_ref()
                    .filter(|e| e.interface == address.name)
                    .map(|e| e.port)
                    .unwrap_or(0);
                meta.endpoint = Some(EndpointSetting {
                    interface: address.name.clone(),
                    port,
                });
                store::write_metadata(&self.dir, &meta)?;
                s.meta = meta;
                drop(s);
                self.restore_endpoint(&EndpointSetting {
                    interface: address.name,
                    port,
                });
                return Ok(());
            }
        }
        self.publish(&s);
        Ok(())
    }

    fn refresh_endpoint(self: &Arc<Self>) {
        let _guard = self
            .endpoint_config
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let (setting, current) = {
            let s = self.lock();
            (
                s.meta.endpoint.clone(),
                s.endpoint.as_ref().map(|e| e.ip.to_string()),
            )
        };
        let Some(setting) = setting else { return };
        let address = crate::network_addresses()
            .unwrap_or_default()
            .into_iter()
            .find(|a| a.name == setting.interface && remembered_ip(a))
            .map(|a| a.address);
        if address != current {
            self.stop_endpoint();
            self.restore_endpoint(&setting);
        }
    }

    /// Revalidates the saved interface by name. A missing interface is reported, never replaced.
    fn restore_endpoint(self: &Arc<Self>, setting: &EndpointSetting) {
        let found = crate::network_addresses()
            .unwrap_or_default()
            .into_iter()
            .find(|a| a.name == setting.interface && remembered_ip(a));
        let Some(address) = found else {
            let mut s = self.lock();
            s.endpoint_error = Some(format!(
                "{} is not connected. Reconnect it, or choose another network for remembered devices.",
                setting.interface
            ));
            self.publish(&s);
            return;
        };
        let ip: Ipv4Addr = address.address.parse().unwrap();
        let result = link::listen(self.clone(), ip, setting.port);
        let mut s = self.lock();
        match result {
            Ok((port, cancel)) => {
                let mut meta = s.meta.clone();
                if let Some(e) = meta.endpoint.as_mut() {
                    e.port = port;
                }
                if store::write_metadata(&self.dir, &meta).is_ok() {
                    s.meta = meta;
                }
                let advertisement = crate::discovery::advertise_remembered(ip, port, &self.name);
                s.endpoint = Some(Endpoint {
                    ip,
                    cancel,
                    advertisement,
                });
                s.endpoint_error = None;
            }
            Err(error) => s.endpoint_error = Some(error),
        }
        self.publish(&s);
    }

    fn stop_endpoint(&self) {
        let mut s = self.lock();
        if let Some(endpoint) = s.endpoint.take() {
            let _ = endpoint.cancel.send(true);
            if let Some(advertisement) = endpoint.advertisement {
                std::thread::spawn(move || drop(advertisement));
            }
        }
        for (_, link) in s.links.drain() {
            let _ = link.cancel.send(true);
        }
        for (request_id, request) in s.requests.drain() {
            self.event(TrustEvent::Cancelled {
                request_id,
                device_id: request.device,
            });
        }
    }

    /// Verifies one challenge answer against active, non-revoked records. Never uses names or IPs.
    pub(crate) fn authenticate(
        &self,
        key: &str,
        server_nonce: &str,
        client_nonce: &str,
        signature: &str,
    ) -> Option<String> {
        let s = self.lock();
        let mine = s.identity.as_ref()?.public_key();
        let record = s
            .peers
            .iter()
            .find(|p| p.key == key && p.status == Status::Active && !s.revoked.contains(&p.key))?;
        (server_nonce != client_nonce
            && crypto::verify(
                key,
                &crypto::reconnect_transcript(&mine, key, server_nonce, client_nonce),
                signature,
            ))
        .then(|| record.id.clone())
    }

    pub(crate) fn link_opened(
        &self,
        device: &str,
        out: mpsc::Sender<String>,
        cancel: watch::Sender<bool>,
    ) -> Option<u64> {
        let mut s = self.lock();
        if !s
            .peers
            .iter()
            .any(|p| p.id == device && p.status == Status::Active && !s.revoked.contains(&p.key))
            || s.endpoint.is_none()
        {
            return None;
        }
        s.next_link += 1;
        let generation = s.next_link;
        if let Some(old) = s.links.insert(
            device.into(),
            LinkHandle {
                generation,
                out,
                cancel,
            },
        ) {
            let _ = old.cancel.send(true);
        }
        s.requests.retain(|_, r| r.device != device);
        self.publish(&s);
        Some(generation)
    }

    pub(crate) fn link_closed(&self, device: &str, generation: u64) {
        let mut s = self.lock();
        if s.links
            .get(device)
            .is_some_and(|l| l.generation == generation)
        {
            s.links.remove(device);
            let gone: Vec<_> = s
                .requests
                .iter()
                .filter(|(_, r)| r.device == device)
                .map(|(id, _)| id.clone())
                .collect();
            for id in gone {
                s.requests.remove(&id);
                self.event(TrustEvent::Cancelled {
                    request_id: id,
                    device_id: device.into(),
                });
            }
            self.publish(&s);
        }
    }

    pub fn shutdown(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let _guard = self
            .endpoint_config
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.stop_endpoint();
    }
}

impl Drop for Trust {
    fn drop(&mut self) {
        self.stop_endpoint();
    }
}

/// Remembered endpoints are LAN only. Carrier-grade NAT (Tailscale and similar) stays pairing-only.
fn remembered_ip(address: &crate::NetworkAddress) -> bool {
    let Ok(ip) = address.address.parse::<Ipv4Addr>() else {
        return false;
    };
    address.selectable && (ip.is_private() || ip.is_link_local())
}

/// Enrollment's durable writes against secure storage. A pending record is written before the
/// confirm is sent; activation replaces any older record with the same key.
struct Records<'a> {
    trust: &'a Trust,
    state: &'a mut State,
}

#[cfg(test)]
mod tests;
