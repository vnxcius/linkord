package com.linkord.voice

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

class OggOpusTest {
    @Test
    fun crcMatchesOggs() {
        // The CRC of "OggS" alone with Ogg's parameters (checked against libogg's table).
        assertEquals(0x5fb0a94f, OggOpus.crc("OggS".toByteArray()).toLong() and 0xffffffffL)
    }

    @Test
    fun pagesAndGranules() {
        val packets = List(120) { ByteArray(if (it == 3) 600 else 40) { 1 } }
        val bytes = ByteArrayOutputStream().also { OggOpus.write(it, packets) }.toByteArray()
        var at = 0
        val pages = ArrayList<Triple<Int, Long, Int>>()
        while (at < bytes.size) {
            assertEquals("OggS", String(bytes, at, 4))
            val flags = bytes[at + 5].toInt()
            var granule = 0L
            for (i in 0 until 8) granule = granule or ((bytes[at + 6 + i].toLong() and 0xff) shl (8 * i))
            val segs = bytes[at + 26].toInt() and 0xff
            var body = 0
            for (i in 0 until segs) body += bytes[at + 27 + i].toInt() and 0xff
            pages += Triple(flags, granule, segs)
            at += 27 + segs + body
        }
        assertEquals(bytes.size, at)
        assertEquals(2 + 3, pages.size)
        assertEquals(2, pages[0].first)
        assertEquals(4, pages.last().first)
        assertEquals(OggOpus.PRE_SKIP + 120L * 960, pages.last().second)
        // The 600-byte packet takes three lacing values (255, 255, 90).
        assertEquals(52, pages[2].third)
    }
}
