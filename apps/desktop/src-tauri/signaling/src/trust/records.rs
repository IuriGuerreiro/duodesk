//! Pending writes and activation after the peer acknowledges durable storage.
use super::*;

impl Records<'_> {
    fn write(&mut self, key: &str, name: &str) -> Result<String, String> {
        if self
            .state
            .peers
            .iter()
            .filter(|p| p.status == Status::Active && !self.state.revoked.contains(&p.key))
            .count()
            >= MAX_DEVICES
        {
            return Err("Too many remembered phones. Forget one first.".into());
        }
        let id = crate::random_hex(16);
        let mut peers: Vec<_> = self
            .state
            .peers
            .iter()
            .filter(|p| !self.state.revoked.contains(&p.key))
            .cloned()
            .collect();
        peers.push(PeerRecord {
            id: id.clone(),
            key: key.into(),
            status: Status::Pending,
            created_at: now_ms(),
        });
        self.trust.save_peers(self.state, &peers)?;
        let mut meta = self.state.meta.clone();
        meta.names.insert(id.clone(), name.into());
        store::write_metadata(&self.trust.dir, &meta)?;
        self.state.meta = meta;
        self.state.peers = peers;
        Ok(id)
    }
}

impl enroll::Records for Records<'_> {
    fn save_pending(&mut self, key: &str, name: &str) -> Result<String, String> {
        self.write(key, name)
    }
    fn activate(&mut self, id: &str) -> Result<(), String> {
        let key = self
            .state
            .peers
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.key.clone())
            .ok_or("Pending record lost")?;
        let mut peers: Vec<_> = self
            .state
            .peers
            .iter()
            .filter(|p| p.key != key || p.id == id)
            .cloned()
            .collect();
        for p in &mut peers {
            if p.id == id {
                p.status = Status::Active;
            }
        }
        self.trust.save_peers(self.state, &peers)?;
        let mut meta = self.state.meta.clone();
        meta.revoked.retain(|k| k != &key);
        store::write_metadata(&self.trust.dir, &meta)?;
        self.state.meta = meta;
        self.state.revoked.retain(|k| k != &key);
        self.state.peers = peers;
        Ok(())
    }
    fn discard(&mut self, id: &str) {
        let peers: Vec<_> = self
            .state
            .peers
            .iter()
            .filter(|p| !(p.id == id && p.status == Status::Pending))
            .cloned()
            .collect();
        if peers.len() != self.state.peers.len()
            && self.trust.save_peers(self.state, &peers).is_ok()
        {
            self.state.peers = peers;
        } else {
            // Not durable yet, but pending records never authorize and are dropped at startup.
            self.state
                .peers
                .retain(|p| !(p.id == id && p.status == Status::Pending));
        }
        self.state.meta.names.remove(id);
    }
}
