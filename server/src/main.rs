mod activities;
mod api;
mod auth;
mod config;
mod direct;
mod embeds;
mod error;
mod gateway;
mod id;
mod models;
mod perms;
mod ratelimit;
mod spotify;
mod state;
mod uploads;
mod voice;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::{AppState, Inner};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "linkord_server=info,tower_http=warn".into()))
        .init();

    let cfg = Config::from_env()?;
    if cfg.dev_login {
        tracing::warn!("LINKORD_DEV_LOGIN is enabled: anyone can sign in as any username. Do not use on a public server.");
    }
    if !cfg.discord_enabled() {
        tracing::warn!("DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set: Discord login disabled");
    }

    let db = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&cfg.database_url)
        .await
        .context("connecting to postgres")?;
    sqlx::migrate!("./migrations").run(&db).await.context("running migrations")?;
    tokio::fs::create_dir_all(cfg.uploads_dir()).await?;

    let st = AppState(Arc::new(Inner {
        http: reqwest::Client::builder().user_agent("linkord (https://github.com/linkord, 0.1)").timeout(Duration::from_secs(15)).build()?,
        hub: Default::default(),
        voice: Default::default(),
        pending_logins: Default::default(),
        oauth_states: Default::default(),
        limits: Default::default(),
        embed_cache: Default::default(),
        activities: Default::default(),
        spotify_states: Default::default(),
        games: Default::default(),
        db,
        cfg: cfg.clone(),
    }));
    tokio::spawn(auth::sweep(st.clone()));
    tokio::spawn(gateway::presence_sweeper(st.clone()));
    tokio::spawn(activities::keep_list(st.clone()));
    tokio::spawn(activities::sweep_games(st.clone()));
    tokio::spawn(activities::keep_custom_statuses(st.clone()));
    if cfg.spotify_enabled() {
        tokio::spawn(spotify::poller(st.clone()));
    }
    tokio::fs::create_dir_all(cfg.data_dir.join("updates")).await?;

    let api = Router::new()
        .merge(auth::routes())
        .merge(api::routes())
        .merge(spotify::routes())
        .merge(activities::routes())
        .merge(voice::routes())
        .route("/gateway", get(gateway::ws_handler))
        .route("/health", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(uploads::MAX_FILE * 4));

    let web = ServeDir::new(&cfg.web_dir).fallback(ServeFile::new(cfg.web_dir.join("index.html")));
    let app = Router::new()
        .nest("/api", api)
        .nest_service("/uploads", ServeDir::new(cfg.uploads_dir()))
        .nest_service("/api/updates/download", ServeDir::new(cfg.data_dir.join("updates")))
        .fallback_service(web)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(st.clone());
    let direct_st = st;

    if cfg.direct_bind.is_some() && cfg.direct_host.is_empty() {
        anyhow::bail!("LINKORD_DIRECT_BIND needs LINKORD_DIRECT_HOST");
    }
    let direct = app.clone();
    tokio::spawn(async move {
        if let Err(e) = direct::serve(direct_st, direct).await {
            tracing::error!("direct access stopped: {e:#}");
        }
    });

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await.with_context(|| format!("binding {}", cfg.bind))?;
    tracing::info!("linkord listening on {} (public url {})", cfg.bind, cfg.public_url);
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
