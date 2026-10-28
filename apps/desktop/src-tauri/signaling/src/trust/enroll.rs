//! Desktop side of enrollment on a paired session socket. One enrollment per session at a time.
//!
//! Initiator I and responder R, either device:
//! 1. I → `enroll_request {key, nonce, name}` after its user chose Remember.
//! 2. R's user approves → R signs → `enroll_accept {key, nonce, name, signature}`.
//! 3. I verifies, writes a pending record, signs → `enroll_confirm {signature}` (I saved).
//! 4. R verifies, writes an active record (I already saved) → `enroll_saved`.
//! 5. I activates its pending record.
//!
//! Pending records never authorize anything and are discarded on cancel, timeout or disconnect.
use super::crypto::{self, EnrollFields, Identity, Signer};
use serde_json::{Value, json};

pub const MAX_ATTEMPTS: u8 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Msg {
    Hello,
    Request {
        key: String,
        nonce: String,
        name: String,
    },
    Accept {
        key: String,
        nonce: String,
        name: String,
        signature: String,
    },
    Confirm {
        signature: String,
    },
    Saved,
    Cancel,
}

pub fn is_enroll(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| t.starts_with("enroll_"))
}

/// Strict parse of a phone message. Mirrors `parseEnrollMessage` in @duodesk/protocol.
pub fn parse(value: &Value, session_id: &str) -> Result<Msg, String> {
    let object = value.as_object().ok_or("Invalid enrollment message")?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fields: &[&str] = match kind {
        "enroll_hello" | "enroll_saved" | "enroll_cancel" => &[],
        "enroll_request" => &["key", "nonce", "name"],
        "enroll_accept" => &["key", "nonce", "name", "signature"],
        "enroll_confirm" => &["signature"],
        _ => return Err("Invalid enrollment message".into()),
    };
    if object.len() != fields.len() + 3
        || object.get("v").and_then(Value::as_u64) != Some(1)
        || object.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || !fields
            .iter()
            .all(|f| object.get(*f).is_some_and(Value::is_string))
    {
        return Err("Invalid enrollment fields".into());
    }
    let s = |f: &str| object[f].as_str().unwrap().to_string();
    let ok = fields.iter().all(|f| match *f {
        "key" => crypto::is_public_key(&s(f)),
        "nonce" => crypto::is_nonce(&s(f)),
        "signature" => crypto::is_signature(&s(f)),
        "name" => clean_name(&s(f)).as_deref() == Some(s(f).as_str()),
        _ => false,
    });
    if !ok {
        return Err("Invalid enrollment values".into());
    }
    Ok(match kind {
        "enroll_hello" => Msg::Hello,
        "enroll_saved" => Msg::Saved,
        "enroll_cancel" => Msg::Cancel,
        "enroll_request" => Msg::Request {
            key: s("key"),
            nonce: s("nonce"),
            name: s("name"),
        },
        "enroll_accept" => Msg::Accept {
            key: s("key"),
            nonce: s("nonce"),
            name: s("name"),
            signature: s("signature"),
        },
        _ => Msg::Confirm {
            signature: s("signature"),
        },
    })
}

pub fn encode(session_id: &str, msg: &Msg) -> String {
    let mut value = match msg {
        Msg::Hello => json!({"type": "enroll_hello"}),
        Msg::Saved => json!({"type": "enroll_saved"}),
        Msg::Cancel => json!({"type": "enroll_cancel"}),
        Msg::Request { key, nonce, name } => {
            json!({"type": "enroll_request", "key": key, "nonce": nonce, "name": name})
        }
        Msg::Accept {
            key,
            nonce,
            name,
            signature,
        } => {
            json!({"type": "enroll_accept", "key": key, "nonce": nonce, "name": name, "signature": signature})
        }
        Msg::Confirm { signature } => json!({"type": "enroll_confirm", "signature": signature}),
    };
    value["v"] = json!(1);
    value["sessionId"] = json!(session_id);
    value.to_string()
}

/// Same rules as `deviceName` in @duodesk/protocol: no control or bidi characters, trimmed, at most 40.
pub fn clean_name(value: &str) -> Option<String> {
    let kept: String = value
        .chars()
        .filter(|c| {
            let n = *c as u32;
            !(n < 0x20
                || (0x7f..=0x9f).contains(&n)
                || n == 0x200e
                || n == 0x200f
                || (0x202a..=0x202e).contains(&n)
                || (0x2066..=0x2069).contains(&n))
        })
        .collect();
    let trimmed: String = kept.trim().chars().take(40).collect();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// The session values every enrollment signature binds.
pub struct Context {
    pub session_id: String,
    pub certificate_fingerprint: String,
    pub token_hash: String,
}

/// Durable writes the state machine needs. Each must be complete before it returns Ok.
pub trait Records {
    fn save_pending(&mut self, key: &str, name: &str) -> Result<String, String>;
    fn activate(&mut self, id: &str) -> Result<(), String>;
    fn discard(&mut self, id: &str);
}

#[derive(Debug)]
enum Phase {
    Idle,
    Requested {
        nonce: String,
        name: Option<String>,
    },
    Incoming {
        key: String,
        nonce: String,
        peer: String,
    },
    Accepted {
        key: String,
        peer_nonce: String,
        nonce: String,
        name: String,
    },
    Confirmed {
        id: String,
    },
    Done,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    pub send: Vec<Msg>,
    /// `enroll` UI state: capable, requested, incoming, verifying, saved, cancelled, failed.
    pub state: Option<&'static str>,
    pub peer_name: Option<String>,
    pub message: Option<String>,
    /// Set when a record became active, so the caller can bind the session and refresh status.
    pub activated: Option<String>,
}

impl Outcome {
    fn none() -> Self {
        Self {
            send: vec![],
            state: None,
            peer_name: None,
            message: None,
            activated: None,
        }
    }
    fn state(state: &'static str) -> Self {
        Self {
            state: Some(state),
            ..Self::none()
        }
    }
    fn fail(message: &str) -> Self {
        Self {
            send: vec![Msg::Cancel],
            state: Some("failed"),
            message: Some(message.into()),
            ..Self::none()
        }
    }
}

pub struct Enrollment {
    pub ctx: Context,
    capable: bool,
    attempts: u8,
    phase: Phase,
    /// Bumps on every new request so a stale timeout cannot cancel a later attempt.
    pub generation: u64,
}

impl Enrollment {
    pub fn new(ctx: Context) -> Self {
        Self {
            ctx,
            capable: false,
            attempts: 0,
            phase: Phase::Idle,
            generation: 0,
        }
    }

    pub fn capable(&self) -> bool {
        self.capable
    }

    fn fields<'a>(
        &'a self,
        desktop_key: &'a str,
        phone_key: &'a str,
        desktop_nonce: &'a str,
        phone_nonce: &'a str,
    ) -> EnrollFields<'a> {
        EnrollFields {
            session_id: &self.ctx.session_id,
            certificate_fingerprint: &self.ctx.certificate_fingerprint,
            token_hash: &self.ctx.token_hash,
            desktop_key,
            phone_key,
            desktop_nonce,
            phone_nonce,
        }
    }

    fn reset(&mut self, records: &mut dyn Records) {
        if let Phase::Confirmed { id } = &self.phase {
            records.discard(id);
        }
        self.phase = Phase::Idle;
    }

    /// Discards anything pending. Used on disconnect, timeout and session end.
    pub fn abandon(&mut self, records: &mut dyn Records) -> Outcome {
        let active = !matches!(self.phase, Phase::Idle | Phase::Done);
        self.reset(records);
        if active {
            Outcome {
                send: vec![Msg::Cancel],
                ..Outcome::state("cancelled")
            }
        } else {
            Outcome::none()
        }
    }

    /// The local user chose Remember. `name` is optional; the phone's suggestion is used otherwise.
    pub fn start(
        &mut self,
        identity: &Identity,
        own_name: &str,
        name: Option<String>,
    ) -> Result<Outcome, String> {
        if !self.capable {
            return Err(
                "This phone's DuoDesk version cannot be remembered. Update it, then pair again."
                    .into(),
            );
        }
        if !matches!(self.phase, Phase::Idle) {
            return Err("A remember request is already in progress.".into());
        }
        if self.attempts >= MAX_ATTEMPTS {
            return Err("Too many remember requests in this session. Pair again to retry.".into());
        }
        self.attempts += 1;
        self.generation += 1;
        let nonce = crypto::nonce();
        self.phase = Phase::Requested {
            nonce: nonce.clone(),
            name,
        };
        Ok(Outcome {
            send: vec![Msg::Request {
                key: identity.public_key(),
                nonce,
                name: own_name.into(),
            }],
            ..Outcome::state("requested")
        })
    }

    /// The local user approved the phone's request.
    pub fn approve(
        &mut self,
        identity: &Identity,
        own_name: &str,
        name: Option<String>,
    ) -> Result<Outcome, String> {
        let Phase::Incoming {
            key,
            nonce: peer_nonce,
            peer,
        } = &self.phase
        else {
            return Err("There is no remember request to approve.".into());
        };
        let (key, peer_nonce, peer) = (key.clone(), peer_nonce.clone(), peer.clone());
        let nonce = crypto::nonce();
        let mine = identity.public_key();
        let signature = identity.sign(&crypto::enroll_transcript(
            Signer::Desktop,
            &self.fields(&mine, &key, &nonce, &peer_nonce),
        ));
        self.phase = Phase::Accepted {
            key,
            peer_nonce,
            nonce: nonce.clone(),
            name: name.unwrap_or(peer),
        };
        Ok(Outcome {
            send: vec![Msg::Accept {
                key: mine,
                nonce,
                name: own_name.into(),
                signature,
            }],
            ..Outcome::state("verifying")
        })
    }

    pub fn reject(&mut self, records: &mut dyn Records) -> Result<Outcome, String> {
        if !matches!(self.phase, Phase::Incoming { .. }) {
            return Err("There is no remember request to decline.".into());
        }
        self.reset(records);
        Ok(Outcome {
            send: vec![Msg::Cancel],
            ..Outcome::state("cancelled")
        })
    }

    pub fn receive(&mut self, identity: &Identity, msg: Msg, records: &mut dyn Records) -> Outcome {
        let mine = identity.public_key();
        match (msg, &self.phase) {
            (Msg::Hello, _) if !self.capable => {
                self.capable = true;
                Outcome::state("capable")
            }
            (Msg::Cancel | Msg::Saved, Phase::Done) => Outcome::none(),
            (Msg::Cancel, Phase::Idle) => Outcome::none(),
            (Msg::Cancel, _) => {
                self.reset(records);
                Outcome::state("cancelled")
            }
            (Msg::Request { key, nonce, name }, Phase::Idle)
                if self.capable && self.attempts < MAX_ATTEMPTS =>
            {
                if key == mine {
                    return Outcome::fail("Invalid device identity.");
                }
                self.attempts += 1;
                self.generation += 1;
                self.phase = Phase::Incoming {
                    key,
                    nonce,
                    peer: name.clone(),
                };
                Outcome {
                    peer_name: Some(name),
                    ..Outcome::state("incoming")
                }
            }
            (
                Msg::Accept {
                    key,
                    nonce: peer_nonce,
                    name: peer,
                    signature,
                },
                Phase::Requested { nonce, name },
            ) => {
                let (nonce, name) = (nonce.clone(), name.clone());
                let phone = crypto::enroll_transcript(
                    Signer::Phone,
                    &self.fields(&mine, &key, &nonce, &peer_nonce),
                );
                if key == mine || !crypto::verify(&key, &phone, &signature) {
                    self.reset(records);
                    return Outcome::fail(
                        "The phone's identity could not be verified. Pair again.",
                    );
                }
                let local = name.unwrap_or_else(|| peer.clone());
                match records.save_pending(&key, &local) {
                    Ok(id) => {
                        let signature = identity.sign(&crypto::enroll_transcript(
                            Signer::Desktop,
                            &self.fields(&mine, &key, &nonce, &peer_nonce),
                        ));
                        self.phase = Phase::Confirmed { id };
                        Outcome {
                            send: vec![Msg::Confirm { signature }],
                            peer_name: Some(peer),
                            ..Outcome::state("verifying")
                        }
                    }
                    Err(error) => {
                        self.reset(records);
                        Outcome::fail(&error)
                    }
                }
            }
            (
                Msg::Confirm { signature },
                Phase::Accepted {
                    key,
                    peer_nonce,
                    nonce,
                    name,
                },
            ) => {
                let (key, peer_nonce, nonce, name) =
                    (key.clone(), peer_nonce.clone(), nonce.clone(), name.clone());
                let phone = crypto::enroll_transcript(
                    Signer::Phone,
                    &self.fields(&mine, &key, &nonce, &peer_nonce),
                );
                if !crypto::verify(&key, &phone, &signature) {
                    self.reset(records);
                    return Outcome::fail(
                        "The phone's identity could not be verified. Pair again.",
                    );
                }
                match records.save_pending(&key, &name) {
                    Ok(id) => {
                        self.phase = Phase::Confirmed { id };
                        Outcome {
                            send: vec![Msg::Saved],
                            ..Outcome::state("verifying")
                        }
                    }
                    Err(error) => {
                        self.reset(records);
                        Outcome::fail(&error)
                    }
                }
            }
            (Msg::Saved, Phase::Confirmed { id }) => {
                let id = id.clone();
                match records.activate(&id) {
                    Ok(()) => {
                        self.phase = Phase::Done;
                        Outcome {
                            send: vec![Msg::Saved],
                            activated: Some(id),
                            ..Outcome::state("saved")
                        }
                    }
                    Err(error) => {
                        // The phone already saved; fail closed here. Reconnecting will ask to pair again.
                        self.reset(records);
                        Outcome::fail(&error)
                    }
                }
            }
            // Simultaneous requests, repeats, or out-of-order messages: both sides start over.
            _ => {
                let busy = !matches!(self.phase, Phase::Idle | Phase::Done);
                self.reset(records);
                if busy {
                    Outcome::fail("Remember was interrupted. Try again.")
                } else {
                    Outcome {
                        send: vec![Msg::Cancel],
                        ..Outcome::none()
                    }
                }
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    pub struct Mem {
        pub records: BTreeMap<String, (String, String, bool)>,
        pub fail: bool,
    }
    impl Records for Mem {
        fn save_pending(&mut self, key: &str, name: &str) -> Result<String, String> {
            if self.fail {
                return Err("disk".into());
            }
            let id = format!("p{}", self.records.len());
            self.records
                .insert(id.clone(), (key.into(), name.into(), false));
            Ok(id)
        }
        fn activate(&mut self, id: &str) -> Result<(), String> {
            if self.fail {
                return Err("disk".into());
            }
            self.records.get_mut(id).unwrap().2 = true;
            Ok(())
        }
        fn discard(&mut self, id: &str) {
            self.records.remove(id);
        }
    }

    fn ctx() -> Context {
        Context {
            session_id: "a".repeat(32),
            certificate_fingerprint: "b".repeat(64),
            token_hash: "c".repeat(64),
        }
    }

    /// The phone's half, written independently from the spec, to exercise the desktop end to end.
    struct Phone {
        id: Identity,
        nonce: String,
    }
    impl Phone {
        fn sign(&self, desktop_key: &str, desktop_nonce: &str) -> String {
            let pk = self.id.public_key();
            let c = ctx();
            self.id.sign(&crypto::enroll_transcript(
                Signer::Phone,
                &EnrollFields {
                    session_id: &c.session_id,
                    certificate_fingerprint: &c.certificate_fingerprint,
                    token_hash: &c.token_hash,
                    desktop_key,
                    phone_key: &pk,
                    desktop_nonce,
                    phone_nonce: &self.nonce,
                },
            ))
        }
    }

    #[test]
    fn desktop_initiated_enrollment_activates_only_after_phone_saved() {
        let desktop = Identity::generate().unwrap();
        let phone = Phone {
            id: Identity::generate().unwrap(),
            nonce: crypto::nonce(),
        };
        let mut records = Mem::default();
        let mut e = Enrollment::new(ctx());
        assert!(
            e.start(&desktop, "Desk", None).is_err(),
            "needs hello first"
        );
        assert_eq!(
            e.receive(&desktop, Msg::Hello, &mut records).state,
            Some("capable")
        );
        let out = e.start(&desktop, "Desk", Some("My phone".into())).unwrap();
        let Msg::Request { nonce: dn, .. } = &out.send[0] else {
            panic!()
        };
        let accept = Msg::Accept {
            key: phone.id.public_key(),
            nonce: phone.nonce.clone(),
            name: "Pixel".into(),
            signature: phone.sign(&desktop.public_key(), dn),
        };
        let out = e.receive(&desktop, accept, &mut records);
        let Msg::Confirm { signature } = &out.send[0] else {
            panic!("{out:?}")
        };
        // The desktop's confirm verifies with the phone's view of the transcript.
        let pk = phone.id.public_key();
        let c = ctx();
        assert!(crypto::verify(
            &desktop.public_key(),
            &crypto::enroll_transcript(
                Signer::Desktop,
                &EnrollFields {
                    session_id: &c.session_id,
                    certificate_fingerprint: &c.certificate_fingerprint,
                    token_hash: &c.token_hash,
                    desktop_key: &desktop.public_key(),
                    phone_key: &pk,
                    desktop_nonce: dn,
                    phone_nonce: &phone.nonce,
                }
            ),
            signature
        ));
        let pending = records.records.values().next().unwrap().clone();
        assert_eq!(
            (pending.1.as_str(), pending.2),
            ("My phone", false),
            "pending, not yet trusted"
        );
        let out = e.receive(&desktop, Msg::Saved, &mut records);
        assert!(out.activated.is_some());
        assert!(records.records.values().next().unwrap().2);
    }

    #[test]
    fn phone_initiated_enrollment_requires_local_approval_and_valid_signature() {
        let desktop = Identity::generate().unwrap();
        let phone = Phone {
            id: Identity::generate().unwrap(),
            nonce: crypto::nonce(),
        };
        let mut records = Mem::default();
        let mut e = Enrollment::new(ctx());
        // A request before hello is refused.
        let early = e.receive(
            &desktop,
            Msg::Request {
                key: phone.id.public_key(),
                nonce: phone.nonce.clone(),
                name: "Pixel".into(),
            },
            &mut records,
        );
        assert_eq!(early.send, vec![Msg::Cancel]);
        e.receive(&desktop, Msg::Hello, &mut records);
        let out = e.receive(
            &desktop,
            Msg::Request {
                key: phone.id.public_key(),
                nonce: phone.nonce.clone(),
                name: "Pixel".into(),
            },
            &mut records,
        );
        assert_eq!(
            (out.state, out.peer_name.as_deref()),
            (Some("incoming"), Some("Pixel"))
        );
        assert!(
            records.records.is_empty(),
            "nothing is written before approval"
        );
        let out = e.approve(&desktop, "Desk", None).unwrap();
        let Msg::Accept { nonce: dn, .. } = &out.send[0] else {
            panic!()
        };
        // A confirm signed for a different desktop nonce (replay) fails closed.
        let bad = e.receive(
            &desktop,
            Msg::Confirm {
                signature: phone.sign(&desktop.public_key(), &crypto::nonce()),
            },
            &mut records,
        );
        assert_eq!(bad.state, Some("failed"));
        assert!(records.records.is_empty());
        let _ = dn;
    }

    #[test]
    fn phone_initiated_happy_path_and_cancel_discards_pending() {
        let desktop = Identity::generate().unwrap();
        let phone = Phone {
            id: Identity::generate().unwrap(),
            nonce: crypto::nonce(),
        };
        let mut records = Mem::default();
        let mut e = Enrollment::new(ctx());
        e.receive(&desktop, Msg::Hello, &mut records);
        e.receive(
            &desktop,
            Msg::Request {
                key: phone.id.public_key(),
                nonce: phone.nonce.clone(),
                name: "Pixel".into(),
            },
            &mut records,
        );
        let out = e
            .approve(&desktop, "Desk", Some("Work phone".into()))
            .unwrap();
        let Msg::Accept { nonce: dn, .. } = &out.send[0] else {
            panic!()
        };
        let out = e.receive(
            &desktop,
            Msg::Confirm {
                signature: phone.sign(&desktop.public_key(), dn),
            },
            &mut records,
        );
        assert_eq!(out.send, vec![Msg::Saved]);
        assert_eq!(
            records.records.values().next().unwrap(),
            &(phone.id.public_key(), "Work phone".into(), false)
        );
        assert!(out.activated.is_none());
        assert!(
            e.receive(&desktop, Msg::Saved, &mut records)
                .activated
                .is_some()
        );
        assert!(records.records.values().next().unwrap().2);

        // Desktop-initiated attempt cancelled after the pending write discards it.
        let mut records = Mem::default();
        let mut e = Enrollment::new(ctx());
        e.receive(&desktop, Msg::Hello, &mut records);
        let out = e.start(&desktop, "Desk", None).unwrap();
        let Msg::Request { nonce: dn, .. } = &out.send[0] else {
            panic!()
        };
        e.receive(
            &desktop,
            Msg::Accept {
                key: phone.id.public_key(),
                nonce: phone.nonce.clone(),
                name: "Pixel".into(),
                signature: phone.sign(&desktop.public_key(), dn),
            },
            &mut records,
        );
        assert_eq!(records.records.len(), 1);
        e.receive(&desktop, Msg::Cancel, &mut records);
        assert!(records.records.is_empty());
    }

    #[test]
    fn storage_failure_never_reports_saved() {
        let desktop = Identity::generate().unwrap();
        let phone = Phone {
            id: Identity::generate().unwrap(),
            nonce: crypto::nonce(),
        };
        let mut records = Mem {
            fail: true,
            ..Default::default()
        };
        let mut e = Enrollment::new(ctx());
        e.receive(&desktop, Msg::Hello, &mut records);
        e.receive(
            &desktop,
            Msg::Request {
                key: phone.id.public_key(),
                nonce: phone.nonce.clone(),
                name: "Pixel".into(),
            },
            &mut records,
        );
        let out = e.approve(&desktop, "Desk", None).unwrap();
        let Msg::Accept { nonce: dn, .. } = &out.send[0] else {
            panic!()
        };
        let out = e.receive(
            &desktop,
            Msg::Confirm {
                signature: phone.sign(&desktop.public_key(), dn),
            },
            &mut records,
        );
        assert_eq!(out.state, Some("failed"));
        assert_eq!(out.send, vec![Msg::Cancel]);
    }

    #[test]
    fn parse_is_exact() {
        let sid = "a".repeat(32);
        let key = Identity::generate().unwrap().public_key();
        let ok = json!({"v":1,"sessionId":sid,"type":"enroll_request","key":key,"nonce":"0".repeat(64),"name":"Pixel"});
        assert!(parse(&ok, &sid).is_ok());
        let mut extra = ok.clone();
        extra["x"] = json!(1);
        assert!(parse(&extra, &sid).is_err());
        let mut name = ok.clone();
        name["name"] = json!(" Pixel");
        assert!(parse(&name, &sid).is_err());
        assert!(parse(&ok, &"b".repeat(32)).is_err());
        let round: Value = serde_json::from_str(&encode(
            &sid,
            &Msg::Request {
                key: key.clone(),
                nonce: "0".repeat(64),
                name: "Pixel".into(),
            },
        ))
        .unwrap();
        assert_eq!(round, ok);
    }
}
