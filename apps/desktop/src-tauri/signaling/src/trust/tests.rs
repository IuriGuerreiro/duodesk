use super::*;
use std::sync::atomic::Ordering;
use store::testing::MemoryStore;

fn open(store: Arc<MemoryStore>) -> (Arc<Trust>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("duodesk-trust-test-{}", crypto::nonce()));
    let trust = Trust::open(
        dir.clone(),
        store,
        Arc::new(|_| {}),
        tokio::runtime::Handle::current(),
    );
    (trust, dir)
}
fn enroll(trust: &Trust, phone: &Identity, active: bool) -> String {
    let mut s = trust.lock();
    let mut records = Records {
        trust,
        state: &mut s,
    };
    use super::enroll::Records as _;
    let id = records.save_pending(&phone.public_key(), "Pixel").unwrap();
    if active {
        records.activate(&id).unwrap();
    }
    id
}
#[tokio::test]
async fn trust_identity_and_local_names_survive_restart_but_pending_does_not() {
    let store = Arc::new(MemoryStore::default());
    let (trust, dir) = open(store.clone());
    let key = trust.public_key().unwrap();
    let phone = Identity::generate().unwrap();
    let id = enroll(&trust, &phone, true);
    trust.rename(&id, "My phone").unwrap();
    enroll(&trust, &Identity::generate().unwrap(), false);
    drop(trust);
    let trust = Trust::open(
        dir.clone(),
        store,
        Arc::new(|_| {}),
        tokio::runtime::Handle::current(),
    );
    assert_eq!(trust.public_key().unwrap(), key);
    let s = trust.status();
    assert_eq!(s.devices.len(), 1);
    assert_eq!(s.devices[0].name, "My phone");
    trust.forget(&id).unwrap();
    assert!(trust.status().devices.is_empty());
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn challenges_reject_other_keys_nonces_and_pending_records() {
    let (trust, dir) = open(Arc::new(MemoryStore::default()));
    let phone = Identity::generate().unwrap();
    let id = enroll(&trust, &phone, false);
    let (server, client) = (crypto::nonce(), crypto::nonce());
    let signature = phone.sign(&crypto::reconnect_transcript(
        &trust.public_key().unwrap(),
        &phone.public_key(),
        &server,
        &client,
    ));
    assert!(
        trust
            .authenticate(&phone.public_key(), &server, &client, &signature)
            .is_none()
    );
    {
        use super::enroll::Records as _;
        let mut s = trust.lock();
        Records {
            trust: &trust,
            state: &mut s,
        }
        .activate(&id)
        .unwrap();
    }
    assert_eq!(
        trust.authenticate(&phone.public_key(), &server, &client, &signature),
        Some(id.clone())
    );
    assert!(
        trust
            .authenticate(&phone.public_key(), &crypto::nonce(), &client, &signature)
            .is_none()
    );
    assert!(
        trust
            .authenticate(
                &Identity::generate().unwrap().public_key(),
                &server,
                &client,
                &signature
            )
            .is_none()
    );
    trust.forget(&id).unwrap();
    assert!(
        trust
            .authenticate(&phone.public_key(), &server, &client, &signature)
            .is_none()
    );
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn forget_blocks_now_and_after_restart_when_keyring_write_fails() {
    let store = Arc::new(MemoryStore::default());
    let (trust, dir) = open(store.clone());
    let phone = Identity::generate().unwrap();
    let id = enroll(&trust, &phone, true);
    store.fail.store(true, Ordering::SeqCst);
    trust.forget(&id).unwrap(); // durable metadata tombstone
    assert!(trust.status().devices.is_empty());
    drop(trust);
    store.fail.store(false, Ordering::SeqCst);
    let trust = Trust::open(
        dir.clone(),
        store,
        Arc::new(|_| {}),
        tokio::runtime::Handle::current(),
    );
    assert!(trust.status().devices.is_empty());
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn requests_need_both_users_and_are_one_use_and_bound_to_link() {
    let (trust, dir) = open(Arc::new(MemoryStore::default()));
    let id = enroll(&trust, &Identity::generate().unwrap(), true);
    let (cancel, _) = watch::channel(false);
    trust.lock().endpoint = Some(Endpoint {
        ip: "192.168.1.2".parse().unwrap(),
        cancel,
        advertisement: None,
    });
    let (out, mut rx) = mpsc::channel(16);
    let (cancel, _) = watch::channel(false);
    let generation = trust.link_opened(&id, out, cancel).unwrap();
    let request = trust.connect(&id, Direction::PhoneToDesktop).unwrap();
    rx.recv().await.unwrap();
    assert!(trust.take_approved(&request).is_err());
    trust.on_link(&id, generation, link::Incoming::Accept(request.clone()));
    assert_eq!(trust.take_approved(&request).unwrap().device, id);
    assert!(trust.take_approved(&request).is_err());
    trust.cancel_request(&request).unwrap();
    let request = crate::random_hex(16);
    trust.on_link(
        &id,
        generation,
        link::Incoming::Request {
            request_id: request.clone(),
            direction: Direction::DesktopToPhone,
        },
    );
    assert!(trust.take_approved(&request).is_err());
    trust.respond(&request, true).unwrap();
    trust.link_closed(&id, generation);
    assert!(trust.take_approved(&request).is_err());
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn storage_failure_disables_remembering_but_does_not_invent_a_new_identity() {
    let store = Arc::new(MemoryStore::default());
    store.fail.store(true, Ordering::SeqCst);
    let (trust, dir) = open(store);
    assert!(!trust.status().available);
    assert!(trust.public_key().is_none());
    assert!(trust.status().error.is_some());
    assert!(trust.enroll_command("start", None).is_err());
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn pending_reenrollment_does_not_clear_a_forget_tombstone() {
    let store = Arc::new(MemoryStore::default());
    let (trust, dir) = open(store.clone());
    let phone = Identity::generate().unwrap();
    let old = enroll(&trust, &phone, true);
    store.fail.store(true, Ordering::SeqCst);
    trust.forget(&old).unwrap();
    store.fail.store(false, Ordering::SeqCst);
    let pending = enroll(&trust, &phone, false);
    let (server, client) = (crypto::nonce(), crypto::nonce());
    let signature = phone.sign(&crypto::reconnect_transcript(
        &trust.public_key().unwrap(),
        &phone.public_key(),
        &server,
        &client,
    ));
    assert!(
        trust
            .authenticate(&phone.public_key(), &server, &client, &signature)
            .is_none()
    );
    {
        use super::enroll::Records as _;
        let mut s = trust.lock();
        Records {
            trust: &trust,
            state: &mut s,
        }
        .activate(&pending)
        .unwrap();
    }
    assert_eq!(
        trust.authenticate(&phone.public_key(), &server, &client, &signature),
        Some(pending)
    );
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn cancelling_after_acceptance_prevents_delivery_and_stops_an_issued_session() {
    let (trust, dir) = open(Arc::new(MemoryStore::default()));
    let id = enroll(&trust, &Identity::generate().unwrap(), true);
    let (cancel, _) = watch::channel(false);
    trust.lock().endpoint = Some(Endpoint {
        ip: "192.168.1.2".parse().unwrap(),
        cancel,
        advertisement: None,
    });
    let (out, mut rx) = mpsc::channel(16);
    let (cancel, _) = watch::channel(false);
    let generation = trust.link_opened(&id, out, cancel).unwrap();
    let invitation = Invitation {
        v: 1,
        direction: Direction::PhoneToDesktop,
        session_id: "a".repeat(32),
        url: "wss://192.168.1.2:12345/".into(),
        token: "b".repeat(64),
        fingerprint: "c".repeat(64),
        expires_at: now_ms() + 120000,
    };
    for delivered in [false, true] {
        let request = trust.connect(&id, Direction::PhoneToDesktop).unwrap();
        rx.recv().await.unwrap();
        trust.on_link(&id, generation, link::Incoming::Accept(request.clone()));
        let approved = trust.take_approved(&request).unwrap();
        let (cancel, mut cancelled) = watch::channel(false);
        if delivered {
            trust
                .deliver(&approved, &invitation, Arc::new(cancel.clone()))
                .unwrap();
            rx.recv().await.unwrap();
        }
        trust.on_link(&id, generation, link::Incoming::Cancel(request));
        if delivered {
            cancelled.changed().await.unwrap();
            assert!(*cancelled.borrow());
        } else {
            assert!(
                trust
                    .deliver(&approved, &invitation, Arc::new(cancel))
                    .is_err()
            );
        }
    }
    drop(trust);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_full_trust_blob_including_pending_records_fits_windows_credentials() {
    let peers: Vec<_> = (0..MAX_DEVICES)
        .map(|_| PeerRecord {
            id: "a".repeat(32),
            key: format!("04{}", "a".repeat(128)),
            status: Status::Pending,
            created_at: u64::MAX,
        })
        .collect();
    assert!(store::encode_peers(&peers).len() <= 2560);
}
