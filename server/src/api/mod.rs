pub mod channels;
pub mod dms;
pub mod emojis;
pub mod gifs;
pub mod guilds;
pub mod invites;
pub mod messages;
pub mod relationships;
pub mod roles;
pub mod settings;
pub mod templates;
pub mod updates;
pub mod users;

use axum::Router;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(users::routes())
        .merge(guilds::routes())
        .merge(roles::routes())
        .merge(emojis::routes())
        .merge(channels::routes())
        .merge(messages::routes())
        .merge(invites::routes())
        .merge(dms::routes())
        .merge(relationships::routes())
        .merge(settings::routes())
        .merge(gifs::routes())
        .merge(updates::routes())
        .merge(templates::routes())
}
