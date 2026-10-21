use super::*;
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair},
};
use tokio::{net::TcpStream, time::sleep};
use tokio_rustls::{TlsConnector, client::TlsStream};
use tokio_tungstenite::WebSocketStream;

type Socket = WebSocketStream<TlsStream<TcpStream>>;
fn key() -> EcdsaKeyPair {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap()
}
fn phone(key: &EcdsaKeyPair) -> TrustedPhone {
    TrustedPhone {
        phone_id: hex(&Sha256::digest(key.public_key().as_ref())),
        public_key: hex(key.public_key().as_ref()),
        name: "Test phone".into(),
        created_at: 1,
    }
}
async fn connect(identity: &Identity, address: &str) -> Result<Socket, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(identity.certificate()?).unwrap();
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = TcpStream::connect(address)
        .await
        .map_err(|e| e.to_string())?;
    let ip: std::net::IpAddr = address.split(':').next().unwrap().parse().unwrap();
    let tls = TlsConnector::from(Arc::new(config))
        .connect(rustls::pki_types::ServerName::IpAddress(ip.into()), tcp)
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(
        hex(&Sha256::digest(
            tls.get_ref().1.peer_certificates().unwrap()[0].as_ref()
        )),
        identity.fingerprint()?
    );
    tokio_tungstenite::client_async(format!("wss://{address}/"), tls)
        .await
        .map(|(ws, _)| ws)
        .map_err(|e| e.to_string())
}
async fn send(ws: &mut Socket, message: Value) {
    ws.send(Message::text(message.to_string())).await.unwrap();
}
async fn receive(ws: &mut Socket) -> Value {
    let message = timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap();
    serde_json::from_str(&message).unwrap()
}
async fn rejected(ws: &mut Socket) {
    let result = timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("Rejected connection must close");
    assert!(
        !matches!(result, Some(Ok(Message::Text(_)))),
        "Rejected proof must never return an invitation"
    );
}
struct Fixture {
    key: EcdsaKeyPair,
    phone: TrustedPhone,
    trust: Trust,
    listener: Listener,
    handoffs: mpsc::Receiver<Reconnect>,
}
impl Fixture {
    async fn new() -> Self {
        let key = key();
        let phone = phone(&key);
        let mut trust = Trust::new(
            Identity::generate().unwrap(),
            vec![phone.clone()],
            "unused".into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        trust.challenge_ttl = Duration::from_millis(150);
        let (tx, handoffs) = mpsc::channel(4);
        let ip = interfaces()
            .first()
            .cloned()
            .expect("Tests require a private local IPv4 interface");
        let listener = trust.listen(&ip, 0, tx).await.unwrap();
        Self {
            key,
            phone,
            trust,
            listener,
            handoffs,
        }
    }
    async fn challenge(&self) -> (Socket, Value) {
        let mut ws = connect(&self.trust.identity, &self.listener.address)
            .await
            .unwrap();
        send(
            &mut ws,
            json!({"v":1,"type":"trust_connect","phoneId":self.phone.phone_id}),
        )
        .await;
        let challenge = receive(&mut ws).await;
        assert_eq!(challenge["type"], "trust_challenge");
        (ws, challenge)
    }
    fn proof(&self, challenge: &Value, key: &EcdsaKeyPair) -> Value {
        let bytes = proof_bytes(
            challenge["nonce"].as_str().unwrap(),
            challenge["fingerprint"].as_str().unwrap(),
            challenge["phoneId"].as_str().unwrap(),
        )
        .unwrap();
        let signature = key.sign(&SystemRandom::new(), &bytes).unwrap();
        json!({"v":1,"type":"trust_proof","phoneId":self.phone.phone_id,"signature":hex(signature.as_ref())})
    }
    async fn success(&mut self, ws: &mut Socket, proof: Value) -> Invitation {
        send(ws, proof).await;
        let handoff = timeout(Duration::from_secs(2), self.handoffs.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(self.trust.accepts(&handoff));
        let session = crate::start_with_identity(
            self.listener.address.split(':').next().unwrap().into(),
            Arc::new(|_| {}),
            self.trust.identity.clone(),
            Some(self.trust.clone()),
        )
        .await
        .unwrap();
        let invitation = session.invitation.clone();
        handoff
            .reply
            .send(Ok(invitation.clone()))
            .unwrap_or_else(|_| panic!("Handoff closed"));
        let reply = receive(ws).await;
        assert_eq!(reply["type"], "trust_invitation");
        assert_eq!(
            reply["invitation"]["fingerprint"],
            self.trust.identity.fingerprint().unwrap()
        );
        drop(session);
        invitation
    }
}
#[tokio::test]
async fn real_tls_accepts_proof_once_and_rejects_replay_on_new_connection() {
    let mut f = Fixture::new().await;
    let (mut ws, challenge) = f.challenge().await;
    let proof = f.proof(&challenge, &f.key);
    f.success(&mut ws, proof.clone()).await;
    rejected(&mut ws).await;
    let (mut retry, next) = f.challenge().await;
    assert_ne!(challenge["nonce"], next["nonce"]);
    send(&mut retry, proof).await;
    rejected(&mut retry).await;
    assert!(f.handoffs.try_recv().is_err());
}
#[tokio::test]
async fn real_tls_rejects_unknown_identity_wrong_key_and_wrong_desktop() {
    let f = Fixture::new().await;
    let mut ws = connect(&f.trust.identity, &f.listener.address)
        .await
        .unwrap();
    send(
        &mut ws,
        json!({"v":1,"type":"trust_connect","phoneId":"00".repeat(32)}),
    )
    .await;
    rejected(&mut ws).await;
    let (mut ws, challenge) = f.challenge().await;
    send(&mut ws, f.proof(&challenge, &key())).await;
    rejected(&mut ws).await;
    let (mut ws, mut challenge) = f.challenge().await;
    challenge["fingerprint"] = json!("00".repeat(32));
    send(&mut ws, f.proof(&challenge, &f.key)).await;
    rejected(&mut ws).await;
    let (mut ws, challenge) = f.challenge().await;
    let mut proof = f.proof(&challenge, &f.key);
    proof["phoneId"] = json!("00".repeat(32));
    send(&mut ws, proof).await;
    rejected(&mut ws).await;
}
#[tokio::test]
async fn real_tls_rejects_cross_connection_expired_and_malformed_proofs() {
    let f = Fixture::new().await;
    let (mut first, challenge) = f.challenge().await;
    let (mut second, _) = f.challenge().await;
    send(&mut second, f.proof(&challenge, &f.key)).await;
    rejected(&mut second).await;
    sleep(Duration::from_millis(180)).await;
    let _ = first
        .send(Message::text(f.proof(&challenge, &f.key).to_string()))
        .await;
    rejected(&mut first).await;
    let (mut ws, challenge) = f.challenge().await;
    let mut proof = f.proof(&challenge, &f.key);
    proof["extra"] = json!(true);
    send(&mut ws, proof).await;
    rejected(&mut ws).await;
}
#[tokio::test]
async fn real_tls_revocation_and_disable_invalidate_inflight_challenges() {
    let mut f = Fixture::new().await;
    let (mut ws, challenge) = f.challenge().await;
    f.trust.update(vec![]).unwrap();
    send(&mut ws, f.proof(&challenge, &f.key)).await;
    rejected(&mut ws).await;
    f.trust.update(vec![f.phone.clone()]).unwrap();
    let (mut ws, challenge) = f.challenge().await;
    f.trust.disable();
    send(&mut ws, f.proof(&challenge, &f.key)).await;
    rejected(&mut ws).await;
    assert!(f.handoffs.try_recv().is_err());
    let address = f.listener.address.clone();
    drop(f.listener);
    sleep(Duration::from_millis(20)).await;
    assert!(TcpStream::connect(address).await.is_err());
}
#[tokio::test]
async fn real_tls_pin_mismatch_fails_before_identity_and_listener_defaults_off() {
    let f = Fixture::new().await;
    assert!(
        connect(&Identity::generate().unwrap(), &f.listener.address)
            .await
            .is_err()
    );
    let trust = Trust::new(
        f.trust.identity.clone(),
        vec![f.phone.clone()],
        f.listener.address.clone(),
        Arc::new(|_| {}),
    )
    .unwrap();
    assert!(!trust.inner.lock().unwrap().enabled);
    assert_eq!(CHALLENGE_TTL, Duration::from_secs(30));
}
#[tokio::test]
async fn real_tls_enrollment_requires_pairing_approval_and_current_persisted_key() {
    let key = key();
    let phone = phone(&key);
    let (events, mut received) = mpsc::unbounded_channel();
    let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |event| {
        let _ = events.send(event);
    });
    let trust = Trust::new(
        Identity::generate().unwrap(),
        vec![],
        "192.168.1.1:42889".into(),
        emit.clone(),
    )
    .unwrap();
    let session = crate::start_with_identity(
        interfaces()[0].clone(),
        emit,
        trust.identity.clone(),
        Some(trust.clone()),
    )
    .await
    .unwrap();
    let address = session
        .invitation
        .url
        .trim_start_matches("wss://")
        .trim_end_matches('/');
    let mut ws = connect(&trust.identity, address).await.unwrap();
    send(&mut ws, json!({"v":1,"sessionId":session.invitation.session_id,"type":"pair","token":session.invitation.token})).await;
    assert_eq!(receive(&mut ws).await["type"], "paired");
    let enrollment = json!({"v":1,"sessionId":session.invitation.session_id,"type":"trust_enroll","phoneId":phone.phone_id,"name":phone.name,"publicKey":phone.public_key});
    send(&mut ws, enrollment.clone()).await;
    let request = loop {
        if let Event::TrustEnrollment { request } = timeout(Duration::from_secs(2), received.recv())
            .await
            .unwrap()
            .unwrap()
        {
            break request;
        }
    };
    assert!(
        timeout(Duration::from_millis(20), ws.next()).await.is_err(),
        "No acknowledgement before approval"
    );
    assert!(
        trust.decide(&request.request_id, true).is_err(),
        "Approval requires persisted registry update"
    );
    send(&mut ws, enrollment).await;
    let request = loop {
        if let Event::TrustEnrollment { request } = timeout(Duration::from_secs(2), received.recv())
            .await
            .unwrap()
            .unwrap()
        {
            break request;
        }
    };
    assert_eq!(
        trust.pending_phone(&request.request_id).unwrap().phone_id,
        phone.phone_id
    );
    trust.update(vec![phone.clone()]).unwrap();
    trust.decide(&request.request_id, true).unwrap();
    assert_eq!(receive(&mut ws).await["type"], "trust_committed");
    assert!(trust.pending().is_empty());
    send(
        &mut ws,
        json!({"v":1,"sessionId":session.invitation.session_id,"type":"offer","sdp":"test offer"}),
    )
    .await;
    loop {
        if let Event::Signal { signal } = timeout(Duration::from_secs(2), received.recv())
            .await
            .unwrap()
            .unwrap()
        {
            assert!(matches!(signal.payload, crate::Payload::Offer { .. }));
            break;
        }
    }
    drop(session);
    assert_eq!(receive(&mut ws).await["type"], "stop");
    assert!(trust.pending().is_empty());
}
