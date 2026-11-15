mod activities;
mod api;
mod badges;
mod clips;
mod auth;
mod config;
mod direct;
mod embeds;
mod error;
mod gateway;
mod handover;
mod id;
mod league;
mod internal;
mod logs;
mod media;
mod models;
mod music;
mod perms;
mod previews;
mod push;
mod ratelimit;
mod security;
mod snowball;
mod soundboard;
mod spotify;
mod state;
mod stats;
mod steve;
mod uploads;
mod voice;
mod videos;
mod watch;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use axum::middleware::from_fn;
use axum::routing::get;
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tower::Layer as _;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::config::Config;
use crate::state::{AppState, Inner};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let cfg = Config::from_env()?;
    internal::mark_started();
    // The console (journalctl) as before, plus the redacted daily files the monitor reads.
    let console = EnvFilter::try_from_default_env().unwrap_or_else(|_| "linkord_server=info,tower_http=warn".into());
    let files = tracing_subscriber::filter::Targets::new()
        .with_default(tracing::Level::WARN)
        .with_target("linkord_server", tracing::Level::INFO)
        .with_target("http", tracing::Level::INFO)
        .with_target("client", tracing::Level::INFO)
        .with_target("moderation", tracing::Level::INFO);
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(console))
        .with(logs::FileLayer::new(&cfg.data_dir).with_filter(files))
        .init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "server starting");
    if cfg.dev_login {
        tracing::warn!("LINKORD_DEV_LOGIN is enabled: anyone can sign in as any username. Do not use on a public server.");
    }
    let names: Vec<&String> = cfg.admins.iter().filter(|a| a.parse::<u64>().is_err()).collect();
    if !names.is_empty() {
        tracing::warn!("LINKORD_ADMINS has names in it: a Discord username can be taken by someone else after it's released. Use numeric Discord ids.");
    }
    if !cfg.discord_enabled() {
        tracing::warn!("DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set: Discord login disabled");
    }

    // At boot Postgres may still be starting.
    let mut attempt = 0;
    let db = loop {
        match PgPoolOptions::new().max_connections(20).acquire_timeout(Duration::from_secs(5)).connect(&cfg.database_url).await {
            Ok(db) => break db,
            Err(e) if attempt < 30 => {
                attempt += 1;
                tracing::warn!("connecting to postgres: {e} (retrying)");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e).context("connecting to postgres"),
        }
    };
    let migrator = sqlx::migrate!("./migrations");
    let _ = internal::MIGRATIONS.set(migrator.iter().count());
    migrator.run(&db).await.context("running migrations")?;
    tokio::fs::create_dir_all(cfg.uploads_dir()).await?;
    tokio::fs::create_dir_all(&cfg.nameplates_dir).await?;

    let st = AppState(Arc::new(Inner {
        http: reqwest::Client::builder().user_agent("Linkord (https://linkord.app)").timeout(Duration::from_secs(15)).build()?,
        hub: Default::default(),
        voice: Default::default(),
        pending_logins: Default::default(),
        oauth_states: Default::default(),
        limits: Default::default(),
        embed_cache: Default::default(),
        activities: Default::default(),
        spotify_states: Default::default(),
        games: Default::default(),
        league: Default::default(),
        music: Default::default(),
        steve: Default::default(),
        watches: Default::default(),
        previews: Default::default(),
        db,
        cfg: cfg.clone(),
    }));
    push::init(&st).context("setting up push notifications")?;
    music::init(&st).await.context("creating the music bot")?;
    steve::init(&st).await.context("creating steve")?;

    // Everything that can fail is done: take over from the running server (a deploy), or pick up what a server that
    // just stopped saved. Either way people in calls stay in them (handover.rs).
    let (snapshot, incoming) = match handover::take_over(&cfg).await? {
        Some(mut i) => (Some(std::mem::take(&mut i.snapshot)), Some(i)),
        None => (handover::saved_snapshot(&cfg), None),
    };
    if let Some(snap) = snapshot {
        id::set_parity(snap.parity ^ 1);
        handover::restore(&st, snap).await;
    }
    tokio::spawn(music::keep_ytdlp_updated(st.clone()));
    tokio::spawn(auth::sweep(st.clone()));
    tokio::spawn(uploads::backfill_image_sizes(st.clone()));
    tokio::spawn(videos::backfill(st.clone()));
    tokio::spawn(logs::prune(st.clone()));
    tokio::spawn(gateway::presence_sweeper(st.clone()));
    tokio::spawn(voice::afk_sweeper(st.clone()));
    tokio::spawn(activities::keep_list(st.clone()));
    tokio::spawn(league::keep_champions(st.clone()));
    tokio::spawn(league::keep_cache(st.clone()));
    tokio::spawn(api::updates::watch(st.clone()));
    tokio::spawn(activities::sweep_games(st.clone()));
    tokio::spawn(activities::keep_custom_statuses(st.clone()));
    tokio::spawn(badges::sweeper(st.clone()));
    if cfg.spotify_enabled() {
        tokio::spawn(spotify::poller(st.clone()));
    }
    tokio::fs::create_dir_all(cfg.data_dir.join("updates")).await?;
    tokio::spawn(internal::serve(st.clone()));
    tokio::spawn(clips::sweep_uploads(st.clone()));

    let api = Router::new()
        .merge(auth::routes())
        .merge(api::routes())
        .merge(spotify::routes())
        .merge(activities::routes())
        .merge(league::routes())
        .merge(voice::routes())
        .merge(music::routes())
        .merge(steve::routes())
        .merge(logs::routes())
        .merge(soundboard::routes())
        .merge(snowball::routes())
        .merge(watch::routes())
        .merge(previews::routes())
        .merge(push::routes())
        .merge(badges::routes())
        .merge(clips::routes())
        .route("/gateway", get(gateway::ws_handler))
        .route("/health", get(|| async { "ok" }))
        // The real limit per route is in security::api_limit.
        .layer(DefaultBodyLimit::max(uploads::MESSAGE_BODY))
        .layer(axum::middleware::from_fn_with_state(st.clone(), security::api_limit));

    let web = ServeDir::new(&cfg.web_dir).fallback(ServeFile::new(cfg.web_dir.join("index.html")));
    let app = Router::new()
        .nest("/api", api)
        // REC's shared clips: a plain page anyone with the link can open (clips.rs).
        .merge(clips::page_routes())
        // Uploads live under random paths and nameplates rarely change: let browsers keep them, so long lists
        // (member list, nameplate picker) don't fetch every file again.
        .nest_service("/uploads", from_fn(security::upload_headers).layer(cached(ServeDir::new(cfg.uploads_dir()), "public, max-age=604800")))
        .nest_service("/nameplates", from_fn(security::upload_headers).layer(cached(ServeDir::new(&cfg.nameplates_dir), "public, max-age=86400")))
        .nest_service("/soundboard", from_fn(security::upload_headers).layer(cached(ServeDir::new(&cfg.sounds_dir), "public, max-age=86400")))
        .nest_service("/api/updates/download", from_fn(security::upload_headers).layer(ServeDir::new(cfg.data_dir.join("updates"))))
        .fallback_service(from_fn(security::web_headers).layer(web))
        .layer(axum::middleware::from_fn(logs::access_log))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(st.clone());
    let direct_st = st.clone();
    let signal_st = st.clone();
    let successor_st = st;

    if cfg.direct_bind.is_some() && cfg.direct_host.is_empty() {
        anyhow::bail!("LINKORD_DIRECT_BIND needs LINKORD_DIRECT_HOST");
    }
    let direct = app.clone();
    tokio::spawn(async move {
        if let Err(e) = direct::serve(direct_st, direct).await {
            tracing::error!("direct access stopped: {e:#}");
        }
    });

    let listener = handover::listener("main", &cfg.bind).and_then(tokio::net::TcpListener::from_std).with_context(|| format!("binding {}", cfg.bind))?;
    tracing::info!("linkord listening on {} (public url {})", cfg.bind, cfg.public_url);
    tokio::spawn(handover::on_signal(signal_st));
    if let Some(i) = incoming {
        i.ready(successor_st.clone()).await;
    }
    handover::mark_live(&cfg);
    tokio::spawn(handover::serve_successors(successor_st));
    handover::until_drained(async {
        if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(handover::stop_accepting()).await {
            tracing::error!("server stopped: {e}");
        }
    })
    .await;
    handover::finish().await;
    Ok(())
}

fn cached<S>(svc: S, value: &'static str) -> tower_http::set_header::SetResponseHeader<S, axum::http::HeaderValue> {
    tower_http::set_header::SetResponseHeader::if_not_present(svc, axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static(value))
}
