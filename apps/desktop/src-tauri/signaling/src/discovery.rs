//! DNS-SD advertisement of the bootstrap endpoint while a pairing code is active.
//! The record is untrusted: it carries only a display name and the protocol version,
//! never the code, token, invitation or certificate fingerprint.
use mdns_sd::{IfKind, ServiceDaemon, ServiceInfo};
use std::net::Ipv4Addr;

pub const SERVICE_TYPE: &str = "_duodesk._tcp.local.";

pub struct Advertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        // Unregister sends a goodbye packet so browsers drop the entry promptly.
        if let Ok(done) = self.daemon.unregister(&self.fullname) {
            let _ = done.recv_timeout(std::time::Duration::from_millis(500));
        }
        let _ = self.daemon.shutdown();
    }
}

/// Friendly, bounded display name. Not trusted by the phone either way.
pub fn display_name() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .unwrap_or_default();
    let clean: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    if clean.is_empty() {
        "DuoDesk PC".into()
    } else {
        clean
    }
}

pub fn records(name: &str, instance: &str) -> Vec<(&'static str, String)> {
    vec![
        ("v", "1".into()),
        ("role", "desktop".into()),
        ("name", name.into()),
        ("id", instance.into()),
    ]
}

/// Best effort: discovery failure must not block QR/manual pairing.
pub fn advertise(ip: Ipv4Addr, port: u16, instance: &str) -> Option<Advertisement> {
    let daemon = ServiceDaemon::new().ok()?;
    // Announce only on the interface the user selected, never on VPN/virtual adapters.
    daemon.disable_interface(IfKind::All).ok()?;
    daemon.enable_interface(IfKind::Addr(ip.into())).ok()?;
    let host = format!("duodesk-{instance}.local.");
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &format!("DuoDesk-{instance}"),
        &host,
        std::net::IpAddr::V4(ip),
        port,
        &records(&display_name(), instance)[..],
    )
    .ok()?;
    let fullname = info.get_fullname().to_string();
    daemon.register(info).ok()?;
    Some(Advertisement { daemon, fullname })
}

pub const REMEMBERED_SERVICE_TYPE: &str = "_duodesk-trust._tcp.local.";

/// TXT for the remembered endpoint: no key, fingerprint or stable ID, so adverts cannot track a PC.
pub fn remembered_records(name: &str) -> Vec<(&'static str, String)> {
    vec![
        ("v", "1".into()),
        ("role", "desktop".into()),
        ("name", name.into()),
    ]
}

/// Advertises the remembered endpoint with a fresh random instance. Phones still check the TLS key.
pub fn advertise_remembered(ip: Ipv4Addr, port: u16, name: &str) -> Option<Advertisement> {
    let daemon = ServiceDaemon::new().ok()?;
    daemon.disable_interface(IfKind::All).ok()?;
    daemon.enable_interface(IfKind::Addr(ip.into())).ok()?;
    let instance = crate::random_hex(4);
    let info = ServiceInfo::new(
        REMEMBERED_SERVICE_TYPE,
        &format!("DuoDeskR-{instance}"),
        &format!("duodesk-r-{instance}.local."),
        std::net::IpAddr::V4(ip),
        port,
        &remembered_records(name)[..],
    )
    .ok()?;
    let fullname = info.get_fullname().to_string();
    daemon.register(info).ok()?;
    Some(Advertisement { daemon, fullname })
}

#[cfg(test)]
mod tests {
    #[test]
    fn remembered_records_carry_no_identity() {
        let keys: Vec<_> = remembered_records("Desk").iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["v", "role", "name"]);
    }
    use super::*;
    #[test]
    fn records_contain_no_secrets() {
        let txt = records("Desk", "0123abcd");
        let keys: Vec<_> = txt.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["v", "role", "name", "id"]);
    }
    #[test]
    fn display_name_is_bounded() {
        let name = display_name();
        assert!(!name.is_empty() && name.chars().count() <= 40);
    }
    /// Real multicast round trip; needs a private IPv4 interface that allows multicast.
    #[test]
    #[ignore]
    fn browse_finds_and_loses_advertisement() {
        use mdns_sd::ServiceEvent;
        use std::time::{Duration, Instant};
        let ip: Ipv4Addr = crate::interfaces()
            .first()
            .expect("no LAN interface")
            .parse()
            .unwrap();
        let ad = advertise(ip, 45123, "feedbeef").expect("advertise");
        let browser = ServiceDaemon::new().unwrap();
        let events = browser.browse(SERVICE_TYPE).unwrap();
        let wait = |want: fn(&ServiceEvent) -> bool| {
            let end = Instant::now() + Duration::from_secs(8);
            while let Ok(e) = events.recv_timeout(end.saturating_duration_since(Instant::now())) {
                if want(&e) {
                    return true;
                }
            }
            false
        };
        assert!(wait(|e| matches!(e, ServiceEvent::ServiceResolved(i)
            if i.get_fullname().starts_with("DuoDesk-feedbeef") && i.get_port() == 45123
            && i.get_property_val_str("role") == Some("desktop"))));
        drop(ad);
        assert!(wait(
            |e| matches!(e, ServiceEvent::ServiceRemoved(_, n) if n.starts_with("DuoDesk-feedbeef"))
        ));
        let _ = browser.shutdown();
    }
}
