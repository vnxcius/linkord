use std::ops::Deref;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

use crate::auth::Attempts;
use crate::checks::CheckState;
use crate::config::Config;
use crate::store::Store;

pub struct Inner {
    pub cfg: Config,
    pub store: Store,
    pub http: reqwest::Client,
    pub db: PgPool,
    pub attempts: Attempts,
    /// The latest system + app reading (sampler.rs).
    pub live: RwLock<Value>,
    pub checks: RwLock<Vec<CheckState>>,
    /// TLS certificates of the app's addresses, refreshed hourly.
    pub certs: RwLock<Value>,
    /// Public IP and Cloudflare location, refreshed every few minutes.
    pub trace: RwLock<Value>,
    /// Folder sizes, refreshed every 10 minutes (storage.rs).
    pub storage: RwLock<Value>,
    /// Latest quick Postgres numbers (pg.rs).
    pub pg_quick: RwLock<Value>,
    pub speedtest: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(cfg: Config) -> anyhow::Result<AppState> {
        let store = Store::open(&cfg.data_dir)?;
        // Read only, small and impatient: a slow dashboard query is cancelled long before it could bother the app,
        // and the database refuses any write from this connection.
        let options = PgConnectOptions::from_str(&cfg.database_url)?.application_name("linkord-monitor").options([
            ("default_transaction_read_only", "on"),
            ("statement_timeout", "8000"),
            ("lock_timeout", "1000"),
            ("idle_in_transaction_session_timeout", "10000"),
        ]);
        let db = PgPoolOptions::new()
            .max_connections(3)
            .min_connections(0)
            .acquire_timeout(Duration::from_secs(4))
            .idle_timeout(Duration::from_secs(120))
            .connect_lazy_with(options);
        let http = reqwest::Client::builder().user_agent("linkord-monitor").timeout(Duration::from_secs(10)).connect_timeout(Duration::from_secs(6)).build()?;
        Ok(AppState(Arc::new(Inner {
            cfg,
            store,
            http,
            db,
            attempts: Default::default(),
            live: RwLock::new(Value::Null),
            checks: RwLock::new(vec![]),
            certs: RwLock::new(Value::Array(vec![])),
            trace: RwLock::new(Value::Null),
            storage: RwLock::new(Value::Null),
            pg_quick: RwLock::new(Value::Null),
            speedtest: tokio::sync::Mutex::new(()),
        })))
    }
}
