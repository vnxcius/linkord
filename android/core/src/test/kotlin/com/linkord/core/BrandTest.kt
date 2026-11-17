package com.linkord.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** Profile link marks, the same matching as the web (tests/brand-icons.test.mjs). */
class BrandTest {
    private fun id(url: String) = brandOf(url)?.id

    @Test fun knownSites() {
        assertEquals("instagram", id("https://www.instagram.com/someone/"))
        assertEquals("instagram", id("instagram.com/someone"))
        assertEquals("youtube", id("https://m.youtube.com/@channel"))
        assertEquals("steam", id("https://store.steampowered.com/app/730"))
        assertEquals("bandcamp", id("https://someone.bandcamp.com"))
        assertEquals("twitter", id("https://x.com/someone"))
        assertEquals("github", id("HTTPS://GITHUB.COM/Someone"))
    }

    @Test fun lookalikesGetNothing() {
        assertEquals(null, id("https://notinstagram.com/x"))
        assertEquals(null, id("https://instagram.com.evil.example/x"))
        assertEquals(null, id("https://apple.com"))
        assertEquals(null, id(""))
        assertEquals(null, id("not a link at all"))
    }

    @Test fun names() {
        assertEquals("My channel", linkName("https://youtube.com/@x", "My channel"))
        assertEquals("Instagram", linkName("https://instagram.com/x", ""))
        assertEquals("example.org/me", linkName("https://www.example.org/me/", ""))
    }
}
