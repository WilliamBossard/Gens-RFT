use russh::client;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use suppaftp::NativeTlsFtpStream;
use tokio::sync::{Mutex, Semaphore, mpsc};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::models::PtyCommand;
use crate::security::ClientHandler;

pub type CancelTokenMap = HashMap<String, (String, Arc<AtomicBool>)>;

#[derive(Clone)]
pub struct FtpSessionConfig {
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Zeroizing<String>,
    pub accept_invalid_certs: bool,
}

pub struct ServerSession {
    pub ssh_session: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
    pub pty_sender: Option<mpsc::Sender<PtyCommand>>,
    pub pty_task: Option<JoinHandle<()>>,
    pub sftp: Option<Arc<SftpSession>>,
    pub sftp_semaphore: Option<Arc<Semaphore>>,
    pub ftp: Option<Arc<std::sync::Mutex<NativeTlsFtpStream>>>,
    pub ftp_pool: Option<Arc<std::sync::Mutex<Vec<NativeTlsFtpStream>>>>,
    pub ftp_config: Option<FtpSessionConfig>,
    pub protocol: String,
    pub current_remote_path: String,
}

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, ServerSession>>>,
    pub cancel_tokens: Arc<Mutex<CancelTokenMap>>,
}

impl AppState {
    pub async fn get_or_create_cancel_token(&self, id: &str, session_id: &str) -> Arc<AtomicBool> {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens
            .entry(id.to_string())
            .or_insert_with(|| (session_id.to_string(), Arc::new(AtomicBool::new(false))))
            .1
            .clone()
    }

    pub async fn cancel_transfer(&self, id: &str, session_id: Option<&str>) {
        let mut tokens = self.cancel_tokens.lock().await;
        if let Some((_, token)) = tokens.get(id) {
            token.store(true, Ordering::Relaxed);
        } else {
            tokens.insert(
                id.to_string(),
                (
                    session_id.unwrap_or_default().to_string(),
                    Arc::new(AtomicBool::new(true)),
                ),
            );
        }
    }

    pub async fn cancel_session_transfers(&self, session_id: &str) {
        let tokens = self.cancel_tokens.lock().await;
        for (sess_id, token) in tokens.values() {
            if sess_id == session_id {
                token.store(true, Ordering::Relaxed);
            }
        }
    }

    pub async fn cancel_all(&self) {
        let tokens = self.cancel_tokens.lock().await;
        for (_, token) in tokens.values() {
            token.store(true, Ordering::Relaxed);
        }
    }

    pub async fn cleanup_cancel_token(&self, id: &str) {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens.remove(id);
    }
}
