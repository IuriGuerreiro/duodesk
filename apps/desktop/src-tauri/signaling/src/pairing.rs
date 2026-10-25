//! Bounded, unauthenticated PAKE transport. No invitation/token is sent here in plaintext.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[derive(Clone, Serialize)]
pub struct NetworkAddress {
    pub name: String,
    pub address: String,
    pub kind: String,
    pub selectable: bool,
}
impl NetworkAddress {
    pub fn new(name: String, ip: Ipv4Addr) -> Self {
        let lower = name.to_lowercase();
        let virtual_adapter = [
            "virtual",
            "vethernet",
            "vmware",
            "vbox",
            "docker",
            "tun",
            "tap",
            "tailscale",
            "zerotier",
            "vpn",
            "wsl",
            "hyper-v",
            "virbr",
            "br-",
            "utun",
        ]
        .iter()
        .any(|s| lower.contains(s));
        let selectable = ip.is_private() || ip.is_link_local();
        let kind = if ip.is_loopback() {
            "loopback"
        } else if virtual_adapter {
            "virtual"
        } else if ip.is_link_local() {
            "link-local"
        } else if ip.is_private() {
            "lan"
        } else {
            "other"
        };
        Self {
            name,
            address: ip.to_string(),
            kind: kind.into(),
            selectable,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairReply {
    pub request_id: String,
    pub message: String,
    pub complete: bool,
}
pub fn spawn(
    listener: TcpListener,
    advertisement: Option<crate::discovery::Advertisement>,
    info: Invitation,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    mut cancelled: watch::Receiver<bool>,
    mut claimed: watch::Receiver<bool>,
    mut replies: mpsc::Receiver<PairReply>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let work = async {
            // A TCP connection consumes an attempt, including malformed/slow clients.
            for _ in 0..8 {
                let (tcp, _) = listener.accept().await.map_err(|_| ())?;
                let request_id = random_hex(16);
                let exchange = async {
                    let mut socket = BufReader::new(tcp);
                    for round in 0..2 {
                        let mut text = Vec::new();
                        // fill_buf bounds allocation before accepting attacker-controlled input.
                        loop {
                            let buffer = socket.fill_buf().await.map_err(|_| ())?;
                            if buffer.is_empty() {
                                return Err(());
                            }
                            let count = buffer
                                .iter()
                                .position(|b| *b == b'\n')
                                .map(|i| i + 1)
                                .unwrap_or(buffer.len());
                            if text.len() + count > 8192 {
                                return Err(());
                            }
                            text.extend_from_slice(&buffer[..count]);
                            socket.consume(count);
                            if text.last() == Some(&b'\n') {
                                text.pop();
                                break;
                            }
                        }
                        let text = String::from_utf8(text).map_err(|_| ())?;
                        emit(Event::Pairing {
                            session_id: info.session_id.clone(),
                            request_id: request_id.clone(),
                            message: text.to_string(),
                        });
                        let reply = loop {
                            let reply = replies.recv().await.ok_or(())?;
                            if reply.request_id == request_id {
                                break reply;
                            }
                        };
                        if reply.message.is_empty()
                            || reply.message.len() > 8192
                            || reply.complete != (round == 1)
                        {
                            return Err(());
                        }
                        socket
                            .get_mut()
                            .write_all(format!("{}\n", reply.message).as_bytes())
                            .await
                            .map_err(|_| ())?;
                        if reply.complete {
                            return Ok(true);
                        }
                    }
                    Ok(false)
                };
                if let Ok(Ok(true)) = timeout(Duration::from_secs(15), exchange).await {
                    return Ok(());
                }
            }
            Err(())
        };
        tokio::select! {
            _ = cancelled.changed() => {},
            _ = claimed.changed() => {},
            _ = sleep(Duration::from_millis(info.expires_at.saturating_sub(now_ms()))) => {},
            result = work => {
                emit(Event::PairingStatus {
                    session_id: info.session_id.clone(),
                    status: if result.is_ok() { "used" } else { "locked" }.into(),
                });
            },
        }
        // Dropping listener and active socket closes all bootstrap work.
        // Withdraw the record off the async workers; unregister waits briefly for the goodbye.
        if let Some(advertisement) = advertisement {
            tokio::task::spawn_blocking(move || drop(advertisement));
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_without_claiming_adapter_type() {
        assert_eq!(
            NetworkAddress::new("vEthernet (WSL)".into(), Ipv4Addr::new(172, 20, 0, 1)).kind,
            "virtual"
        );
        assert_eq!(
            NetworkAddress::new("Wi-Fi".into(), Ipv4Addr::new(192, 168, 1, 2)).kind,
            "lan"
        );
        assert!(!NetworkAddress::new("lo".into(), Ipv4Addr::LOCALHOST).selectable);
        assert!(!NetworkAddress::new("Ethernet".into(), Ipv4Addr::new(8, 8, 8, 8)).selectable);
    }
    fn info(expires_at: u64) -> Invitation {
        Invitation {
            v: 1,
            direction: Direction::PhoneToDesktop,
            session_id: "a".repeat(32),
            token: "b".repeat(64),
            fingerprint: "c".repeat(64),
            url: "unused".into(),
            expires_at,
        }
    }
    #[tokio::test]
    async fn relay_is_bounded_and_one_use() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (events, mut incoming) = mpsc::unbounded_channel();
        let (cancel, cancelled) = watch::channel(false);
        let (claim, claimed) = watch::channel(false);
        let (replies, rx) = mpsc::channel(4);
        let task = spawn(
            listener,
            None,
            info(now_ms() + 2000),
            Arc::new(move |e| {
                events.send(e).unwrap();
            }),
            cancelled,
            claimed,
            rx,
        );
        let mut client = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
        for complete in [false, true] {
            client.get_mut().write_all(b"{}\n").await.unwrap();
            let Event::Pairing {
                request_id,
                message,
                ..
            } = incoming.recv().await.unwrap()
            else {
                panic!("Expected pairing event")
            };
            assert_eq!(message, "{}");
            replies
                .send(PairReply {
                    request_id,
                    message: "response".into(),
                    complete,
                })
                .await
                .unwrap();
            let mut response = String::new();
            client.read_line(&mut response).await.unwrap();
            assert_eq!(response, "response\n");
        }
        timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        drop((cancel, claim));
    }
    #[tokio::test]
    async fn eight_bad_connections_lock_bootstrap() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (cancel, cancelled) = watch::channel(false);
        let (claim, claimed) = watch::channel(false);
        let (_replies, rx) = mpsc::channel(4);
        let task = spawn(
            listener,
            None,
            info(now_ms() + 2000),
            Arc::new(|event| assert!(matches!(event, Event::PairingStatus { .. }))),
            cancelled,
            claimed,
            rx,
        );
        for attempt in 0..8 {
            let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
            if attempt % 2 == 0 {
                socket.get_mut().write_all(&[255, 10]).await.unwrap();
            } else {
                socket.get_mut().write_all(&vec![b'x'; 8193]).await.unwrap();
            }
            let mut response = String::new();
            assert!(match socket.read_line(&mut response).await {
                Ok(0) => true,
                Err(error) => error.kind() == std::io::ErrorKind::ConnectionReset,
                _ => false,
            });
        }
        timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        drop((cancel, claim));
    }
    #[tokio::test]
    async fn cancellation_claim_and_expiry_close_active_socket() {
        for reason in ["cancel", "claim", "expiry"] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let (cancel, cancelled) = watch::channel(false);
            let (claim, claimed) = watch::channel(false);
            let (_replies, rx) = mpsc::channel(4);
            let task = spawn(
                listener,
                None,
                info(now_ms() + 50),
                Arc::new(|_| {}),
                cancelled,
                claimed,
                rx,
            );
            let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
            if reason == "cancel" {
                cancel.send(true).unwrap();
            }
            if reason == "claim" {
                claim.send(true).unwrap();
            }
            timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap();
            let mut response = String::new();
            assert!(match socket.read_line(&mut response).await {
                Ok(0) => true,
                Err(error) => error.kind() == std::io::ErrorKind::ConnectionReset,
                _ => false,
            });
            assert!(tokio::net::TcpStream::connect(address).await.is_err());
        }
    }
}
