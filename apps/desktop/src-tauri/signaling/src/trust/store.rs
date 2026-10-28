//! Durable state. Secrets (identity key, trust records) live in the OS credential store;
//! display metadata and endpoint settings live in a separate JSON file in the app data folder.
//! Every write is complete before the caller reports success.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const SERVICE: &str = "com.duodesk.desktop";

/// Minimal secret storage. Production uses the OS credential store; tests inject their own.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, name: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// Windows Credential Manager, macOS Keychain or the Linux Secret Service, through keyring-core
/// adapters. There is deliberately no plaintext fallback.
pub struct KeyringStore {
    store: std::sync::Arc<keyring_core::CredentialStore>,
}

impl KeyringStore {
    pub fn open() -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        let store = windows_native_keyring_store::Store::new();
        #[cfg(target_os = "macos")]
        let store = apple_native_keyring_store::keychain::Store::new();
        #[cfg(target_os = "linux")]
        let store = zbus_secret_service_keyring_store::Store::new();
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        let store: Result<
            std::sync::Arc<keyring_core::CredentialStore>,
            keyring_core::Error,
        > = Err(keyring_core::Error::NotSupportedByStore("platform".into()));
        let store = store.map_err(|e| unavailable(&e))?;
        Ok(Self { store })
    }

    fn entry(&self, name: &str) -> Result<keyring_core::Entry, String> {
        self.store
            .build(SERVICE, name, None)
            .map_err(|e| unavailable(&e))
    }
}

fn unavailable(_error: &keyring_core::Error) -> String {
    // Never include secret material; platform messages are about the store only.
    let hint = if cfg!(target_os = "linux") {
        "Unlock your login keyring, or install and start a Secret Service such as GNOME Keyring or KWallet."
    } else if cfg!(target_os = "macos") {
        "Unlock your login keychain and allow DuoDesk to use it."
    } else {
        "Check that Windows Credential Manager is available for your account."
    };
    format!("Secure storage is unavailable. {hint} Restart DuoDesk after unlocking it.")
}

impl SecretStore for KeyringStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match self.entry(name)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(unavailable(&error)),
        }
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), String> {
        self.entry(name)?
            .set_secret(value)
            .map_err(|e| unavailable(&e))
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(unavailable(&error)),
        }
    }
}

/// Test-only backends. Never compiled into a shipped host.
#[cfg(any(test, feature = "test-storage"))]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryStore {
        pub values: Mutex<BTreeMap<String, Vec<u8>>>,
        pub fail: std::sync::atomic::AtomicBool,
    }
    impl SecretStore for MemoryStore {
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            self.check()?;
            Ok(self.values.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &[u8]) -> Result<(), String> {
            self.check()?;
            self.values
                .lock()
                .unwrap()
                .insert(name.into(), value.to_vec());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.check()?;
            self.values.lock().unwrap().remove(name);
            Ok(())
        }
    }
    impl MemoryStore {
        fn check(&self) -> Result<(), String> {
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                Err("Secure storage is unavailable (test).".into())
            } else {
                Ok(())
            }
        }
    }

    /// Lets the real sidecar binary run headless in integration tests (built with `--features test-storage`).
    pub struct FileStore(pub PathBuf);
    impl FileStore {
        fn load(&self) -> BTreeMap<String, String> {
            fs::read(&self.0)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default()
        }
        fn save(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
            write_atomic(&self.0, &serde_json::to_vec(map).unwrap())
        }
    }
    impl SecretStore for FileStore {
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .load()
                .get(name)
                .and_then(|v| crate::trust::crypto::unhex(v)))
        }
        fn set(&self, name: &str, value: &[u8]) -> Result<(), String> {
            let mut map = self.load();
            map.insert(name.into(), crate::trust::crypto::hex(value));
            self.save(&map)
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            let mut map = self.load();
            map.remove(name);
            self.save(&map)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Active,
}

/// A trusted phone. Kept in secure storage so its key cannot be swapped by editing app files.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRecord {
    pub id: String,
    pub key: String,
    pub status: Status,
    pub created_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustFile {
    v: u8,
    peers: Vec<PeerRecord>,
}

pub fn decode_peers(bytes: &[u8]) -> Result<Vec<PeerRecord>, String> {
    let file: TrustFile =
        serde_json::from_slice(bytes).map_err(|_| "Stored trust records are unreadable")?;
    if file.v != 1 {
        return Err("Stored trust records use an unknown version".into());
    }
    Ok(file.peers)
}

pub fn encode_peers(peers: &[PeerRecord]) -> Vec<u8> {
    serde_json::to_vec(&TrustFile {
        v: 1,
        peers: peers.to_vec(),
    })
    .unwrap()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointSetting {
    /// OS interface name the user chose. Revalidated on every launch; never auto-selected.
    pub interface: String,
    pub port: u16,
}

/// Not secret and not trusted: names, endpoint choice and forget tombstones.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub v: u8,
    /// Namespaces secure-storage entries so a reinstall never adopts an orphaned identity.
    pub install_id: String,
    pub names: BTreeMap<String, String>,
    pub endpoint: Option<EndpointSetting>,
    /// Public keys forgotten while secure storage could not be updated. Blocked until removed there.
    pub revoked: Vec<String>,
}

pub fn metadata_path(dir: &Path) -> PathBuf {
    dir.join("remembered-devices.json")
}

pub fn read_metadata(dir: &Path) -> Option<Metadata> {
    let bytes = fs::read(metadata_path(dir)).ok()?;
    let meta: Metadata = serde_json::from_slice(&bytes).ok()?;
    (meta.v == 1 && meta.install_id.len() == 32).then_some(meta)
}

pub fn write_metadata(dir: &Path, meta: &Metadata) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| "Could not create the DuoDesk data folder")?;
    write_atomic(
        &metadata_path(dir),
        &serde_json::to_vec_pretty(meta).unwrap(),
    )
}

/// Write, flush and rename, so readers see the old or the new file and never a partial one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        if let Some(parent) = path.parent()
            && let Ok(dir) = fs::File::open(parent)
        {
            let _ = dir.sync_all();
        }
        Ok::<_, std::io::Error>(())
    })();
    result.map_err(|_| {
        let _ = fs::remove_file(&temp);
        format!(
            "Could not save {}",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("settings")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_round_trips_atomically_and_rejects_garbage() {
        let dir =
            std::env::temp_dir().join(format!("duodesk-meta-{}", crate::trust::crypto::nonce()));
        assert!(read_metadata(&dir).is_none());
        let meta = Metadata {
            v: 1,
            install_id: "a".repeat(32),
            ..Default::default()
        };
        write_metadata(&dir, &meta).unwrap();
        assert_eq!(read_metadata(&dir), Some(meta));
        fs::write(metadata_path(&dir), b"{not json").unwrap();
        assert!(read_metadata(&dir).is_none());
        assert!(!dir.join("remembered-devices.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn trust_records_reject_unknown_fields() {
        assert!(
            decode_peers(
                br#"{"v":1,"peers":[{"id":"a","key":"b","status":"active","createdAt":1,"x":1}]}"#
            )
            .is_err()
        );
        let peers = vec![PeerRecord {
            id: "a".into(),
            key: "b".into(),
            status: Status::Active,
            created_at: 1,
        }];
        assert_eq!(decode_peers(&encode_peers(&peers)).unwrap(), peers);
    }
}
