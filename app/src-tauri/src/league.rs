//! League of Legends rich presence (Windows), like Discord's: what the League client is doing, read from its own local
//! API (the "LCU", what Discord, Porofessor and Blitz read; Riot tolerates it, nothing touches the game process) and,
//! in a match, the game's official Live Client Data API on 127.0.0.1:2999. The web app polls `league_status` every
//! few seconds while LeagueClientUx.exe runs (lib/league.ts) and sends a summary with its "Playing" report.
//!
//! The client writes `lockfile` in its install folder: `LeagueClient:<pid>:<port>:<password>:https`. Both APIs use
//! Riot's self-signed certificate on loopback, so certificate checks are off for this client only (it never talks to
//! anything but 127.0.0.1).

use serde::Serialize;

#[derive(Serialize, Default, Debug)]
pub struct LeagueStatus {
    /// The client's gameflow phase: None, Lobby, Matchmaking, ReadyCheck, ChampSelect, InProgress, EndOfGame...
    phase: String,
    queue_id: Option<i64>,
    /// The queue's name in the client's language.
    queue: Option<String>,
    /// CLASSIC, ARAM, CHERRY, TFT, PRACTICETOOL...
    mode: Option<String>,
    party_size: Option<i64>,
    party_max: Option<i64>,
    /// Seconds in the matchmaking queue.
    queue_seconds: Option<f64>,
    champion_id: Option<i64>,
    /// Seconds since the match started (Live Client Data).
    game_time: Option<f64>,
    /// The Riot ID signed in to the client (Settings -> Profile offers to link it).
    game_name: Option<String>,
    tag_line: Option<String>,
    /// The signed-in summoner, for lobby invites through Linkord (the client invites by summoner id).
    summoner_id: Option<i64>,
    puuid: Option<String>,
    /// In a lobby and allowed to invite (the leader, or invites opened to everyone).
    can_invite: Option<bool>,
}

/// What the League client installed in `dir` is doing; None when it isn't running (or is still starting).
#[tauri::command]
pub async fn league_status(dir: Option<String>) -> Result<Option<LeagueStatus>, String> {
    #[cfg(windows)]
    return Ok(imp::status(dir).await);
    #[cfg(not(windows))]
    {
        let _ = dir;
        Err("League of Legends status is only available on Windows".into())
    }
}

/// Has the League client invite this summoner to your lobby (someone asked through Linkord).
#[tauri::command]
pub async fn league_invite(
    dir: Option<String>,
    summoner_id: i64,
    puuid: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    return imp::invite(dir, summoner_id, puuid).await;
    #[cfg(not(windows))]
    {
        let _ = (dir, summoner_id, puuid);
        Err("League of Legends invites are only available on Windows".into())
    }
}

/// Accepts, in your League client, the lobby invite this summoner just sent (you asked to join through Linkord, so
/// joining takes no click in League). Waits a few seconds for it to arrive; false when it never did.
#[tauri::command]
pub async fn league_accept(
    dir: Option<String>,
    from_summoner_id: i64,
    from_puuid: Option<String>,
) -> Result<bool, String> {
    #[cfg(windows)]
    return imp::accept(dir, from_summoner_id, from_puuid).await;
    #[cfg(not(windows))]
    {
        let _ = (dir, from_summoner_id, from_puuid);
        Err("League of Legends invites are only available on Windows".into())
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use serde_json::Value;

    use super::LeagueStatus;

    const DEFAULT_DIR: &str = r"C:\Riot Games\League of Legends";

    fn client() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .expect("League client HTTP client")
        })
    }

    struct Lock {
        port: u16,
        password: String,
    }

    fn lockfile(dir: &str) -> Option<Lock> {
        let raw = std::fs::read_to_string(std::path::Path::new(dir).join("lockfile")).ok()?;
        let parts: Vec<&str> = raw.trim().split(':').collect();
        let (port, password) = (parts.get(2)?.parse().ok()?, parts.get(3)?.to_string());
        Some(Lock { port, password })
    }

    async fn lcu(lock: &Lock, path: &str) -> Option<Value> {
        let res = client()
            .get(format!("https://127.0.0.1:{}{path}", lock.port))
            .basic_auth("riot", Some(&lock.password))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json().await.ok()
    }

    /// The signed-in account (puuid, Riot ID), kept per client session: it doesn't change while the client runs.
    async fn me(lock: &Lock) -> Option<Value> {
        static ME: Mutex<Option<(u16, String, Value)>> = Mutex::new(None);
        if let Some((port, pw, v)) = ME.lock().unwrap().as_ref() {
            if *port == lock.port && *pw == lock.password {
                return Some(v.clone());
            }
        }
        let v = lcu(lock, "/lol-summoner/v1/current-summoner")
            .await
            .filter(|v| v["puuid"].is_string())?;
        *ME.lock().unwrap() = Some((lock.port, lock.password.clone(), v.clone()));
        Some(v)
    }

    fn text(v: &Value) -> Option<String> {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    pub async fn invite(dir: Option<String>, summoner_id: i64, puuid: Option<String>) -> Result<(), String> {
        let lock = dir
            .as_deref()
            .and_then(lockfile)
            .or_else(|| lockfile(DEFAULT_DIR))
            .ok_or("League of Legends isn't open")?;
        let send = |body: serde_json::Value| {
            client()
                .post(format!("https://127.0.0.1:{}/lol-lobby/v2/lobby/invitations", lock.port))
                .basic_auth("riot", Some(&lock.password))
                .json(&body)
                .send()
        };
        let res = send(serde_json::json!([{ "toSummonerId": summoner_id }]))
            .await
            .map_err(|e| e.to_string())?;
        if res.status().is_success() {
            return Ok(());
        }
        // Newer clients may only know players by puuid.
        let first = res.status();
        if let Some(puuid) = puuid {
            let res = send(serde_json::json!([{ "toPuuid": puuid }]))
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                return Ok(());
            }
        }
        Err(format!("League refused the invite ({first})"))
    }

    pub async fn accept(dir: Option<String>, from: i64, puuid: Option<String>) -> Result<bool, String> {
        let lock = dir
            .as_deref()
            .and_then(lockfile)
            .or_else(|| lockfile(DEFAULT_DIR))
            .ok_or("League of Legends isn't open")?;
        let from_them = |inv: &Value| {
            inv["fromSummonerId"].as_i64() == Some(from)
                || puuid.as_deref().is_some_and(|p| {
                    ["fromSummonerPuuid", "fromPuuid"]
                        .iter()
                        .any(|k| inv[*k].as_str() == Some(p))
                })
        };
        // The invite reaches this client a moment after the host's client sends it.
        for _ in 0..20 {
            let list = lcu(&lock, "/lol-lobby/v2/received-invitations").await;
            let found = list.as_ref().and_then(Value::as_array).and_then(|l| {
                l.iter()
                    .find(|inv| inv["state"] == "Pending" && from_them(inv))
                    .and_then(|inv| text(&inv["invitationId"]))
                    .filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            });
            if let Some(id) = found {
                let res = client()
                    .post(format!(
                        "https://127.0.0.1:{}/lol-lobby/v2/received-invitations/{id}/accept",
                        lock.port
                    ))
                    .basic_auth("riot", Some(&lock.password))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                return if res.status().is_success() {
                    Ok(true)
                } else {
                    Err(format!("League refused to join ({})", res.status()))
                };
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok(false)
    }

    pub async fn status(dir: Option<String>) -> Option<LeagueStatus> {
        let lock = dir
            .as_deref()
            .and_then(lockfile)
            .or_else(|| lockfile(DEFAULT_DIR))?;
        let session = lcu(&lock, "/lol-gameflow/v1/session").await;
        let phase = match session.as_ref().and_then(|s| text(&s["phase"])) {
            Some(p) => p,
            None => text(&lcu(&lock, "/lol-gameflow/v1/gameflow-phase").await?)?,
        };
        let me = me(&lock).await;
        let mut out = LeagueStatus {
            phase: phase.clone(),
            ..Default::default()
        };
        if let Some(me) = &me {
            out.game_name = text(&me["gameName"]);
            out.tag_line = text(&me["tagLine"]);
            out.summoner_id = me["summonerId"].as_i64().filter(|id| *id > 0);
            out.puuid = text(&me["puuid"]);
        }
        if let Some(q) = session.as_ref().map(|s| &s["gameData"]["queue"]) {
            out.queue_id = q["id"]
                .as_i64()
                .filter(|id| *id != 0 || q["gameMode"].is_string());
            out.queue = text(&q["description"]);
            out.mode = text(&q["gameMode"]);
        }
        let in_lobby = matches!(
            phase.as_str(),
            "Lobby" | "Matchmaking" | "ReadyCheck" | "ChampSelect" | "CheckedIntoTournament"
        );
        if in_lobby {
            if let Some(lobby) = lcu(&lock, "/lol-lobby/v2/lobby").await {
                out.party_size = lobby["members"].as_array().map(|m| m.len() as i64);
                out.party_max = lobby["gameConfig"]["maxLobbySize"].as_i64();
                let cfg = &lobby["gameConfig"];
                out.queue_id = out.queue_id.or(cfg["queueId"].as_i64());
                out.mode = out.mode.or(text(&cfg["gameMode"]));
                let local = &lobby["localMember"];
                out.can_invite = Some(
                    local["isLeader"].as_bool().unwrap_or(false)
                        || local["allowedInviteOthers"].as_bool().unwrap_or(false),
                );
            }
        }
        match phase.as_str() {
            "Matchmaking" | "ReadyCheck" => {
                if let Some(search) = lcu(&lock, "/lol-matchmaking/v1/search").await {
                    out.queue_seconds = search["timeInQueue"].as_f64();
                }
            }
            "ChampSelect" => {
                if let Some(cs) = lcu(&lock, "/lol-champ-select/v1/session").await {
                    let cell = cs["localPlayerCellId"].as_i64();
                    let mine = cs["myTeam"]
                        .as_array()
                        .and_then(|t| t.iter().find(|p| p["cellId"].as_i64() == cell));
                    if let Some(p) = mine {
                        // Locked or hovered: the pick if there is one, else what they're showing they'll play.
                        out.champion_id = [&p["championId"], &p["championPickIntent"]]
                            .into_iter()
                            .filter_map(Value::as_i64)
                            .find(|id| *id > 0);
                    }
                }
            }
            "GameStart" | "InProgress" | "Reconnect" => {
                let puuid = me
                    .as_ref()
                    .and_then(|m| m["puuid"].as_str().map(str::to_string));
                if let (Some(data), Some(puuid)) = (session.as_ref().map(|s| &s["gameData"]), puuid)
                {
                    out.champion_id = ["playerChampionSelections", "teamOne", "teamTwo"]
                        .iter()
                        .filter_map(|k| data[*k].as_array())
                        .flatten()
                        .find(|p| p["puuid"] == puuid.as_str())
                        .and_then(|p| p["championId"].as_i64())
                        .filter(|id| *id > 0);
                }
                if phase == "InProgress" {
                    let stats = client()
                        .get("https://127.0.0.1:2999/liveclientdata/gamestats")
                        .send()
                        .await
                        .ok();
                    if let Some(res) = stats.filter(|r| r.status().is_success()) {
                        out.game_time = res
                            .json::<Value>()
                            .await
                            .ok()
                            .and_then(|v| v["gameTime"].as_f64());
                    }
                }
            }
            _ => {}
        }
        Some(out)
    }
}
