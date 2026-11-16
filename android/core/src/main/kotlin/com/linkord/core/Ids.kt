package com.linkord.core

/** Ids are decimal strings of u64 (server id.rs). Compares them as numbers without parsing to Double. */
fun cmpId(a: String, b: String): Int = if (a.length != b.length) a.length.compareTo(b.length) else a.compareTo(b)
