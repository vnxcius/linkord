package com.linkord.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MixerTest {
    private fun frame(v: Short) = ShortArray(FRAME * 2) { v }

    @Test
    fun waitsFor60msThenPlays() {
        val m = Mixer()
        val out = ShortArray(FRAME * 2)
        m.push("a", frame(1000))
        m.push("a", frame(1000))
        m.pull(out, muted = false)
        assertEquals(0, out[0].toInt())
        m.push("a", frame(1000))
        m.pull(out, muted = false)
        assertEquals(1000, out[0].toInt())
    }

    @Test
    fun neverMoreThan300msBehind() {
        val m = Mixer()
        val out = ShortArray(FRAME * 2)
        repeat(40) { m.push("a", frame(it.toShort())) }
        m.pull(out, muted = false)
        // 15 frames kept: the first one left is number 25.
        assertEquals(25, out[0].toInt())
    }

    @Test
    fun mixesWithGainsAndStaysInRange() {
        val m = Mixer()
        val out = ShortArray(FRAME * 2)
        m.setGain("b", 0.5f)
        repeat(3) { m.push("a", frame(20000)); m.push("b", frame(20000)) }
        m.pull(out, muted = false)
        assertTrue(out[0] in 25000..32767)
        m.pull(out, muted = true)
        assertEquals(0, out[0].toInt())
    }

    @Test
    fun gateFollowsTheRoomAndHolds() {
        val g = VoiceGate()
        var t = 0L
        repeat(200) { g.open(0.002, t); t += 20 }
        assertEquals(0.008, g.threshold(), 0.002)
        assertTrue(g.open(0.1, t))
        t += 300
        assertTrue("held open after a loud frame", g.open(0.001, t))
        t += 100
        assertFalse(g.open(0.001, t))
    }
}
