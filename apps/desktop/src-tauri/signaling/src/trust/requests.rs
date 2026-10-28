//! Explicit session requests over authenticated waiting links.
use super::*;

impl Trust {
    fn send_link(s: &State, device: &str, text: String) -> Result<(), String> {
        s.links
            .get(device)
            .ok_or("This phone is not connected. Open DuoDesk on the phone, on the same Wi-Fi.")?
            .out
            .try_send(text)
            .map_err(|_| "This phone's link is busy or closed.".into())
    }

    fn expire_later(self: &Arc<Self>, request_id: String, after: Duration) {
        let trust = self.clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(after).await;
            let mut s = trust.lock();
            let expired = s
                .requests
                .get(&request_id)
                .is_some_and(|r| r.at.elapsed() >= after);
            if expired && let Some(r) = s.requests.remove(&request_id) {
                let _ = Self::send_link(
                    &s,
                    &r.device,
                    link::encode_request("connect_cancel", &request_id),
                );
                trust.event(TrustEvent::Cancelled {
                    request_id,
                    device_id: r.device,
                });
                drop(s);
            }
        });
    }

    /// Ask the phone to start a stream. The phone's user must accept.
    pub fn connect(self: &Arc<Self>, device: &str, direction: Direction) -> Result<String, String> {
        let mut s = self.lock();
        Self::require_identity(&s)?;
        let link = s.links.get(device).map(|l| l.generation).ok_or(
            "This phone is not connected. Open DuoDesk on the phone on the same Wi-Fi, or pair with a code.",
        )?;
        if s.requests.values().any(|r| r.device == device) {
            return Err("A request to this phone is already open.".into());
        }
        let request_id = crate::random_hex(16);
        Self::send_link(&s, device, link::encode_connect(&request_id, direction))?;
        s.requests.insert(
            request_id.clone(),
            Request {
                device: device.into(),
                direction,
                origin: Origin::Local,
                phase: Phase::AwaitingRemote,
                at: Instant::now(),
                link,
            },
        );
        drop(s);
        self.expire_later(request_id.clone(), REQUEST_TIMEOUT);
        Ok(request_id)
    }

    /// Local Accept or Decline of a phone's request.
    pub fn respond(self: &Arc<Self>, request_id: &str, accept: bool) -> Result<Direction, String> {
        let mut s = self.lock();
        let request = s
            .requests
            .get(request_id)
            .filter(|r| r.origin == Origin::Remote && r.phase == Phase::AwaitingLocal)
            .ok_or("This request has expired.")?;
        let (device, direction) = (request.device.clone(), request.direction);
        if accept {
            Self::send_link(
                &s,
                &device,
                link::encode_request("connect_accept", request_id),
            )?;
            let r = s.requests.get_mut(request_id).unwrap();
            r.phase = Phase::Approved;
            r.at = Instant::now();
            drop(s);
            self.expire_later(request_id.into(), START_WINDOW);
        } else {
            let _ = Self::send_link(
                &s,
                &device,
                link::encode_request("connect_reject", request_id),
            );
            s.requests.remove(request_id);
        }
        Ok(direction)
    }

    pub fn cancel_request(&self, request_id: &str) -> Result<(), String> {
        let mut s = self.lock();
        if let Some(r) = s.requests.remove(request_id) {
            let _ = Self::send_link(
                &s,
                &r.device,
                link::encode_request("connect_cancel", request_id),
            );
        }
        if s.bound
            .as_ref()
            .is_some_and(|b| b.request_id.as_deref() == Some(request_id))
        {
            let bound = s.bound.take().unwrap();
            let _ = bound.cancel.send(true);
            let _ = Self::send_link(
                &s,
                &bound.device,
                link::encode_request("connect_cancel", request_id),
            );
        }
        Ok(())
    }

    /// Consumes an accepted request so exactly one stream can start from it.
    pub fn take_approved(&self, request_id: &str) -> Result<Approved, String> {
        let mut s = self.lock();
        let ip = s
            .endpoint
            .as_ref()
            .map(|e| e.ip.to_string())
            .ok_or("Remembered devices are turned off.")?;
        let ok = s.requests.get(request_id).is_some_and(|r| {
            r.phase == Phase::Approved
                && r.at.elapsed() < START_WINDOW
                && s.links
                    .get(&r.device)
                    .is_some_and(|l| l.generation == r.link)
        });
        if !ok {
            return Err("This request has expired. Ask again.".into());
        }
        let r = s.requests.get_mut(request_id).unwrap();
        r.phase = Phase::Starting;
        Ok(Approved {
            device: r.device.clone(),
            direction: r.direction,
            ip,
            request_id: request_id.into(),
        })
    }

    /// Sends the fresh one-use invitation over the authenticated link and binds the stream to the phone.
    pub fn deliver(
        &self,
        approved: &Approved,
        invitation: &Invitation,
        cancel: Arc<watch::Sender<bool>>,
    ) -> Result<(), String> {
        let mut s = self.lock();
        if !s.requests.get(&approved.request_id).is_some_and(|r| {
            r.phase == Phase::Starting
                && r.device == approved.device
                && r.at.elapsed() < START_WINDOW
                && s.links
                    .get(&r.device)
                    .is_some_and(|link| link.generation == r.link)
        }) {
            return Err("Connection request was cancelled or expired.".into());
        }
        let text = serde_json::to_string(invitation).unwrap();
        Self::send_link(
            &s,
            &approved.device,
            link::encode_invitation(&approved.request_id, &text),
        )?;
        s.requests.remove(&approved.request_id);
        s.bound = Some(Bound {
            request_id: Some(approved.request_id.clone()),
            session_id: invitation.session_id.clone(),
            device: approved.device.clone(),
            cancel,
        });
        Ok(())
    }

    /// One validated message from an authenticated phone link.
    pub(crate) fn on_link(self: &Arc<Self>, device: &str, generation: u64, msg: link::Incoming) {
        let mut s = self.lock();
        if s.links
            .get(device)
            .is_none_or(|l| l.generation != generation)
        {
            return;
        }
        match msg {
            link::Incoming::Request {
                request_id,
                direction,
            } => {
                if s.requests.values().any(|r| r.device == device)
                    || s.requests.contains_key(&request_id)
                {
                    let _ = Self::send_link(
                        &s,
                        device,
                        link::encode_request("connect_reject", &request_id),
                    );
                    return;
                }
                s.requests.insert(
                    request_id.clone(),
                    Request {
                        device: device.into(),
                        direction,
                        origin: Origin::Remote,
                        phase: Phase::AwaitingLocal,
                        at: Instant::now(),
                        link: generation,
                    },
                );
                drop(s);
                self.event(TrustEvent::Request {
                    request_id: request_id.clone(),
                    device_id: device.into(),
                    direction,
                });
                self.expire_later(request_id, REQUEST_TIMEOUT);
            }
            link::Incoming::Cancel(id)
                if s.bound.as_ref().is_some_and(|b| {
                    b.device == device && b.request_id.as_deref() == Some(&id)
                }) =>
            {
                if let Some(bound) = s.bound.take() {
                    let _ = bound.cancel.send(true);
                }
                self.event(TrustEvent::Cancelled {
                    request_id: id,
                    device_id: device.into(),
                });
            }
            link::Incoming::Accept(id)
            | link::Incoming::Reject(id)
            | link::Incoming::Cancel(id)
                if s.requests.get(&id).is_none_or(|r| r.device != device) => {}
            link::Incoming::Accept(id) => {
                let r = s.requests.get_mut(&id).unwrap();
                if r.origin == Origin::Local && r.phase == Phase::AwaitingRemote {
                    r.phase = Phase::Approved;
                    r.at = Instant::now();
                    let direction = r.direction;
                    drop(s);
                    self.event(TrustEvent::Accepted {
                        request_id: id.clone(),
                        device_id: device.into(),
                        direction,
                    });
                    self.expire_later(id, START_WINDOW);
                }
            }
            link::Incoming::Reject(id) => {
                if s.requests
                    .get(&id)
                    .is_some_and(|r| r.origin == Origin::Local)
                {
                    s.requests.remove(&id);
                    self.event(TrustEvent::Rejected {
                        request_id: id,
                        device_id: device.into(),
                    });
                }
            }
            link::Incoming::Cancel(id) => {
                s.requests.remove(&id);
                self.event(TrustEvent::Cancelled {
                    request_id: id,
                    device_id: device.into(),
                });
            }
            link::Incoming::Forget => {
                drop(s);
                if self.remove(device, false).is_ok() {
                    self.event(TrustEvent::Forgotten {
                        device_id: device.into(),
                    });
                }
            }
        }
    }
}
