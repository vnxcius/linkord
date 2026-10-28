use std::fmt;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

/// 2026-01-01T00:00:00Z
const EPOCH_MS: i64 = 1_767_225_600_000;

/// Snowflake id. Serialized as a string because it does not fit in a JS number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, sqlx::Type)]
#[sqlx(transparent)]
pub struct Id(pub i64);

static GEN: Mutex<(i64, i64)> = Mutex::new((0, 0));

impl Id {
    pub fn new() -> Id {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64 - EPOCH_MS;
        let mut g = GEN.lock().unwrap();
        if now > g.0 {
            *g = (now, 0);
        } else {
            g.1 += 1;
            if g.1 >= 1 << 22 {
                *g = (g.0 + 1, 0);
            }
        }
        Id((g.0 << 22) | g.1)
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for Id {
    type Err = std::num::ParseIntError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse().map(Id)
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl de::Visitor<'_> for V {
            type Value = Id;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a snowflake id")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Id, E> {
                v.parse().map_err(E::custom)
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Id, E> {
                Ok(Id(v))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Id, E> {
                i64::try_from(v).map(Id).map_err(E::custom)
            }
        }
        d.deserialize_any(V)
    }
}
