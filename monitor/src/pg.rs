//! Postgres, from the outside: Postgres's own statistics views, read over the monitor's read-only connection.

use std::time::Duration;

use serde_json::{json, Value};
use sqlx::{FromRow, Row};

use crate::state::AppState;

/// A query slower than this counts as slow.
const SLOW_SECONDS: f64 = 5.0;

/// The few numbers kept over time; every 30 s.
pub async fn keep_quick(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(30));
    let mut previous: Option<(i64, std::time::Instant)> = None;
    loop {
        tick.tick().await;
        let q = sqlx::query(
            "SELECT pg_database_size(current_database())::bigint AS size,
                (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::bigint AS connections,
                (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'
                    AND application_name <> 'linkord-monitor' AND now() - query_start > make_interval(secs => $1))::bigint AS slow,
                (SELECT (xact_commit + xact_rollback)::bigint FROM pg_stat_database WHERE datname = current_database()) AS xacts,
                (SELECT blks_hit::float8 * 100 / NULLIF(blks_hit + blks_read, 0) FROM pg_stat_database WHERE datname = current_database()) AS hit",
        )
        .bind(SLOW_SECONDS)
        .fetch_one(&st.db)
        .await;
        let value = match q {
            Ok(r) => {
                let xacts: i64 = r.get("xacts");
                let now = std::time::Instant::now();
                let tps = previous.map(|(old, at)| (xacts - old).max(0) as f64 / now.duration_since(at).as_secs_f64());
                previous = Some((xacts, now));
                json!({
                    "size": r.get::<i64, _>("size"),
                    "connections": r.get::<i64, _>("connections"),
                    "slow": r.get::<i64, _>("slow"),
                    "cache_hit": r.get::<Option<f64>, _>("hit"),
                    "tps": tps,
                })
            }
            Err(e) => {
                previous = None;
                json!({ "error": e.to_string() })
            }
        };
        *st.pg_quick.write().unwrap() = value;
    }
}

#[derive(FromRow)]
struct TableRow {
    name: String,
    total: i64,
    table_size: i64,
    index_size: i64,
    rows: i64,
    dead: i64,
    seq_scan: i64,
    idx_scan: i64,
    last_vacuum: Option<chrono::DateTime<chrono::Utc>>,
    last_analyze: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn overview(st: &AppState) -> Result<Value, sqlx::Error> {
    let general = sqlx::query(
        "SELECT version() AS version, pg_postmaster_start_time() AS started, current_database()::text AS name,
            pg_database_size(current_database())::bigint AS size,
            current_setting('max_connections')::int AS max_connections,
            current_setting('default_transaction_read_only') = 'on' AS read_only,
            d.numbackends::bigint AS backends, d.xact_commit::bigint AS commits, d.xact_rollback::bigint AS rollbacks,
            d.blks_hit::bigint AS blks_hit, d.blks_read::bigint AS blks_read, d.deadlocks::bigint AS deadlocks,
            d.conflicts::bigint AS conflicts, d.temp_bytes::bigint AS temp_bytes, d.tup_inserted::bigint AS inserted,
            d.tup_updated::bigint AS updated, d.tup_deleted::bigint AS deleted, d.tup_fetched::bigint AS fetched,
            d.stats_reset AS stats_reset
         FROM pg_stat_database d WHERE d.datname = current_database()",
    )
    .fetch_one(&st.db)
    .await?;
    let (hit, read): (i64, i64) = (general.get("blks_hit"), general.get("blks_read"));

    let states: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT COALESCE(state, 'background')::text, count(*)::bigint FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 2 DESC",
    )
    .fetch_all(&st.db)
    .await?;

    let tables: Vec<TableRow> = sqlx::query_as(
        "SELECT relname::text AS name, pg_total_relation_size(relid)::bigint AS total, pg_relation_size(relid)::bigint AS table_size,
            pg_indexes_size(relid)::bigint AS index_size, n_live_tup::bigint AS rows, n_dead_tup::bigint AS dead,
            COALESCE(seq_scan, 0)::bigint AS seq_scan, COALESCE(idx_scan, 0)::bigint AS idx_scan,
            GREATEST(last_vacuum, last_autovacuum) AS last_vacuum, GREATEST(last_analyze, last_autoanalyze) AS last_analyze
         FROM pg_stat_user_tables ORDER BY total DESC",
    )
    .fetch_all(&st.db)
    .await?;

    // Parameters aren't part of the text (sqlx binds them), so no message contents can show up here.
    let activity = sqlx::query(
        "SELECT pid, COALESCE(application_name, '')::text AS app, COALESCE(state, '')::text AS state,
            COALESCE(wait_event_type || ': ' || wait_event, '')::text AS waiting,
            EXTRACT(EPOCH FROM now() - query_start)::float8 AS seconds,
            EXTRACT(EPOCH FROM now() - xact_start)::float8 AS xact_seconds,
            LEFT(query, 400)::text AS query
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'
         ORDER BY query_start NULLS LAST LIMIT 30",
    )
    .fetch_all(&st.db)
    .await?;
    let activity: Vec<Value> = activity
        .iter()
        .map(|r| {
            json!({
                "pid": r.get::<i32, _>("pid"),
                "app": r.get::<String, _>("app"),
                "state": r.get::<String, _>("state"),
                "waiting": r.get::<String, _>("waiting"),
                "seconds": r.get::<Option<f64>, _>("seconds"),
                "xact_seconds": r.get::<Option<f64>, _>("xact_seconds"),
                "query": r.get::<String, _>("query"),
            })
        })
        .collect();

    let waiting_locks: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM pg_locks WHERE NOT granted").fetch_one(&st.db).await?;

    let migrations = sqlx::query(
        "SELECT count(*)::bigint AS applied, count(*) FILTER (WHERE NOT success)::bigint AS failed, MAX(version)::bigint AS latest,
            (SELECT description FROM _sqlx_migrations ORDER BY version DESC LIMIT 1)::text AS latest_name,
            MAX(installed_on) AS installed_on FROM _sqlx_migrations",
    )
    .fetch_one(&st.db)
    .await
    .ok();

    let unused_indexes: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT s.relname::text, s.indexrelname::text, pg_relation_size(s.indexrelid)::bigint FROM pg_stat_user_indexes s
         JOIN pg_index i ON i.indexrelid = s.indexrelid
         WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary ORDER BY 3 DESC LIMIT 10",
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();

    Ok(json!({
        "version": general.get::<String, _>("version"),
        "started": general.get::<chrono::DateTime<chrono::Utc>, _>("started"),
        "name": general.get::<String, _>("name"),
        "size": general.get::<i64, _>("size"),
        "max_connections": general.get::<i32, _>("max_connections"),
        "read_only": general.get::<bool, _>("read_only"),
        "backends": general.get::<i64, _>("backends"),
        "commits": general.get::<i64, _>("commits"),
        "rollbacks": general.get::<i64, _>("rollbacks"),
        "cache_hit": if hit + read > 0 { json!(hit as f64 * 100.0 / (hit + read) as f64) } else { Value::Null },
        "deadlocks": general.get::<i64, _>("deadlocks"),
        "conflicts": general.get::<i64, _>("conflicts"),
        "temp_bytes": general.get::<i64, _>("temp_bytes"),
        "inserted": general.get::<i64, _>("inserted"),
        "updated": general.get::<i64, _>("updated"),
        "deleted": general.get::<i64, _>("deleted"),
        "fetched": general.get::<i64, _>("fetched"),
        "stats_reset": general.get::<Option<chrono::DateTime<chrono::Utc>>, _>("stats_reset"),
        "states": states.iter().map(|(s, n)| json!({ "state": s, "count": n })).collect::<Vec<_>>(),
        "waiting_locks": waiting_locks,
        "tables": tables.iter().map(|t| json!({
            "name": t.name, "total": t.total, "table": t.table_size, "indexes": t.index_size, "rows": t.rows, "dead": t.dead,
            "seq_scan": t.seq_scan, "idx_scan": t.idx_scan, "last_vacuum": t.last_vacuum, "last_analyze": t.last_analyze,
        })).collect::<Vec<_>>(),
        "activity": activity,
        "migrations": migrations.map(|m| json!({
            "applied": m.get::<i64, _>("applied"),
            "failed": m.get::<i64, _>("failed"),
            "latest": m.get::<Option<i64>, _>("latest"),
            "latest_name": m.get::<Option<String>, _>("latest_name"),
            "installed_on": m.get::<Option<chrono::DateTime<chrono::Utc>>, _>("installed_on"),
        })),
        "unused_indexes": unused_indexes.iter().map(|(t, i, s)| json!({ "table": t, "index": i, "size": s })).collect::<Vec<_>>(),
    }))
}
