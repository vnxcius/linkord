package com.linkord.app.ui.profile

import com.linkord.core.plural
import com.linkord.core.t

/** What a badge is, mirroring the web client's lib/badges.ts (same thresholds as server badges.rs LADDERS). */
data class BadgeInfo(val name: String, val tierName: String? = null, val amount: String? = null, val about: String? = null) {
    val line: String get() = amount ?: about ?: ""
}

private const val HOUR = 3600

private class Ladder(val name: String, val unit: String, val thresholds: List<Int>, val amount: (Int) -> String)

private fun age(days: Int): String =
    if (days >= 365) plural(days / 365, "{n} year on Linkord", "{n} years on Linkord")
    else plural(maxOf(1, days / 30), "{n} month on Linkord", "{n} months on Linkord")

private fun hours(vararg h: Int) = h.map { it * HOUR }

private val LADDERS = mapOf(
    "member" to Ladder("Member since", "days", listOf(30, 90, 180, 365, 730)) { age(it) },
    "calls" to Ladder("In calls", "seconds", hours(10, 50, 100, 500, 1000)) { plural(it, "{n} hour in calls", "{n} hours in calls") },
    "played" to Ladder("Time played", "seconds", hours(10, 50, 100, 500, 1000)) { plural(it, "{n} hour played", "{n} hours played") },
    "games" to Ladder("Game library", "count", listOf(5, 10, 25, 50, 100)) { plural(it, "{n} game played", "{n} games played") },
    "live" to Ladder("On air", "seconds", hours(1, 10, 50, 100, 250)) { plural(it, "{n} hour streaming", "{n} hours streaming") },
    "watch" to Ladder("Watch party", "seconds", hours(1, 10, 25, 50, 100)) { plural(it, "{n} hour watching together", "{n} hours watching together") },
    "sounds" to Ladder("Soundboard", "count", listOf(10, 100, 500, 1000, 5000)) { plural(it, "{n} sound played", "{n} sounds played") },
    "snowball" to Ladder("Snowball fighter", "count", listOf(1, 10, 50, 100, 500)) { plural(it, "{n} snowball thrown", "{n} snowballs thrown") },
    "clips" to Ladder("Clip maker", "count", listOf(1, 10, 50, 150, 500)) { plural(it, "{n} clip shared", "{n} clips shared") },
    "views" to Ladder("Audience", "count", listOf(25, 250, 1000, 5000, 25000)) { plural(it, "{n} view on your clips", "{n} views on your clips") },
    "recorded" to Ladder("On record", "seconds", hours(10, 50, 100, 500, 1000)) { plural(it, "{n} hour recorded", "{n} hours recorded") },
)

private val SINGLES = mapOf(
    "admin" to ("Linkord Admin" to "Runs this Linkord"),
    "early" to ("Early Member" to "Here before Linkord 1.0"),
    "owner" to ("Server Owner" to "Created a server"),
    "bug_hunter" to ("Bug Hunter" to "Found and reported a bug"),
    "tester" to ("Tester" to "Tried new builds before release"),
    "contributor" to ("Contributor" to "Helped build Linkord"),
    "helper" to ("Helper" to "Helped others in the community"),
    "premiere" to ("Premiere" to "A clip of theirs was watched together by 3 or more people"),
    "pentakill" to ("Pentakill" to "Caught a League of Legends pentakill on REC"),
)

private val TIER_NAMES = listOf("Bronze", "Silver", "Gold", "Platinum", "Diamond")

/** Names for a badge; null for one this version doesn't know (a newer server's). */
fun describeBadge(b: Badge): BadgeInfo? {
    LADDERS[b.id]?.let { l ->
        val tier = (b.tier ?: 0).coerceIn(0, 4)
        val v = l.thresholds[tier]
        val amount = when (l.unit) {
            "days" -> age(v)
            "seconds" -> l.amount(v / HOUR)
            else -> l.amount(v)
        }
        return BadgeInfo(t(l.name), t(TIER_NAMES[tier]), amount)
    }
    Regex("^christmas_(\\d{4})$").find(b.id)?.let {
        val year = it.groupValues[1]
        return BadgeInfo(t("Christmas {year}", "year" to year), about = t("Here for Christmas {year}", "year" to year))
    }
    return SINGLES[b.id]?.let { (name, about) -> BadgeInfo(t(name), about = t(about)) }
}
