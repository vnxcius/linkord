package com.linkord.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as tests/video-links.test.mjs, so the phone and the web pick the same players. */
class VideoLinksTest {
    private fun play(url: String) = videoPlayer(url, "tauri.localhost")

    @Test
    fun youtube() {
        assertEquals("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0", play("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!!.src)
        assertEquals("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90", play("https://youtu.be/dQw4w9WgXcQ?t=1m30s")!!.src)
        assertTrue(play("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42")!!.src.endsWith("&start=42"))
        val short = play("https://www.youtube.com/shorts/aqz-KE-bpKQ")!!
        assertTrue(short.vertical)
        assertEquals("https://www.youtube.com/embed/aqz-KE-bpKQ?autoplay=1&rel=0", short.src)
        assertNull(play("https://www.youtube.com/@somechannel"))
        assertNull(play("https://www.youtube.com/watch?v=<script>"))
    }

    @Test
    fun theRest() {
        assertTrue(play("https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en")!!.src.startsWith("https://www.tiktok.com/player/v1/6718335390845095173?"))
        assertNull(play("https://www.tiktok.com/@scout2015"))
        assertNull(play("https://vm.tiktok.com/ZMabc123/"))
        assertEquals("https://www.instagram.com/reel/C8fLEo2yGmT/embed/", play("https://www.instagram.com/reel/C8fLEo2yGmT/?igsh=x")!!.src)
        assertEquals("Instagram", play("https://www.instagram.com/reels/C8fLEo2yGmT/")!!.provider)
        assertNull(play("https://www.instagram.com/p/C8fLEo2yGmT/"))
        assertEquals("https://player.vimeo.com/video/76979871?autoplay=1", play("https://vimeo.com/76979871")!!.src)
        assertNull(play("https://vimeo.com/about"))
        assertEquals("https://clips.twitch.tv/embed?clip=FunnyClipSlug&parent=tauri.localhost&autoplay=true", play("https://clips.twitch.tv/FunnyClipSlug")!!.src)
        assertEquals("Twitch", play("https://www.twitch.tv/somestreamer/clip/FunnyClipSlug")!!.provider)
        assertEquals("https://player.twitch.tv/?channel=somestreamer&parent=tauri.localhost&autoplay=true", play("https://www.twitch.tv/somestreamer")!!.src)
        assertEquals("https://streamable.com/e/abc12?autoplay=1", play("https://streamable.com/abc12")!!.src)
        assertEquals("Dailymotion", play("https://dai.ly/x8abc")!!.provider)
        assertNull(play("https://example.com/watch?v=dQw4w9WgXcQ"))
        assertNull(play("not a url"))
    }

    @Test
    fun invites() {
        val origins = listOf("https://linkord.app", "https://direct.example.com:8443")
        assertEquals(listOf("abc123", "Zz9"), inviteCodes("join https://linkord.app/invite/abc123 or https://direct.example.com:8443/invite/Zz9 (https://linkord.app/invite/abc123)", origins))
        assertEquals(emptyList<String>(), inviteCodes("https://example.com/invite/abc", origins))
    }
}
