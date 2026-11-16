package com.linkord.voice

import java.io.OutputStream

/**
 * Writes 48 kHz Opus packets as an Ogg Opus file (RFC 7845): OpusHead, OpusTags, then audio pages of about a second.
 * Voice messages are recorded this way so a paused recording can be played back before it's sent.
 */
object OggOpus {
    /** libopus's lookahead at 48 kHz (what decoders drop from the start). */
    const val PRE_SKIP = 312

    fun write(out: OutputStream, packets: List<ByteArray>, channels: Int = 1, samplesPerPacket: Int = 960) {
        val serial = (System.nanoTime() and 0x7fffffff).toInt()
        var seq = 0
        val head = ByteArray(19).also { h ->
            "OpusHead".toByteArray().copyInto(h)
            h[8] = 1
            h[9] = channels.toByte()
            le16(h, 10, PRE_SKIP)
            le32(h, 12, 48_000)
        }
        page(out, listOf(head), 0, serial, seq++, BOS)
        val vendor = "Linkord".toByteArray()
        val tags = ByteArray(8 + 4 + vendor.size + 4).also { t ->
            "OpusTags".toByteArray().copyInto(t)
            le32(t, 8, vendor.size)
            vendor.copyInto(t, 12)
        }
        page(out, listOf(tags), 0, serial, seq++, 0)
        var granule = PRE_SKIP.toLong()
        val perPage = 50
        if (packets.isEmpty()) page(out, emptyList(), granule, serial, seq, EOS)
        for (start in packets.indices step perPage) {
            val chunk = packets.subList(start, minOf(packets.size, start + perPage))
            granule += chunk.size.toLong() * samplesPerPacket
            page(out, chunk, granule, serial, seq++, if (start + perPage >= packets.size) EOS else 0)
        }
    }

    private const val BOS = 0x02
    private const val EOS = 0x04

    private fun page(out: OutputStream, packets: List<ByteArray>, granule: Long, serial: Int, seq: Int, flags: Int) {
        val lacing = ArrayList<Int>()
        for (p in packets) {
            var n = p.size
            while (n >= 255) {
                lacing += 255
                n -= 255
            }
            lacing += n
        }
        val body = packets.sumOf { it.size }
        val buf = ByteArray(27 + lacing.size + body)
        "OggS".toByteArray().copyInto(buf)
        buf[4] = 0
        buf[5] = flags.toByte()
        for (i in 0 until 8) buf[6 + i] = (granule ushr (8 * i)).toByte()
        le32(buf, 14, serial)
        le32(buf, 18, seq)
        buf[26] = lacing.size.toByte()
        lacing.forEachIndexed { i, l -> buf[27 + i] = l.toByte() }
        var at = 27 + lacing.size
        for (p in packets) {
            p.copyInto(buf, at)
            at += p.size
        }
        le32(buf, 22, crc(buf))
        out.write(buf)
    }

    private val TABLE = IntArray(256) { i ->
        var r = i shl 24
        repeat(8) { r = if (r and 0x80000000.toInt() != 0) (r shl 1) xor 0x04C11DB7 else r shl 1 }
        r
    }

    /** Ogg's CRC-32 (polynomial 0x04C11DB7, not reflected, starting at 0). */
    fun crc(b: ByteArray): Int {
        var c = 0
        for (x in b) c = (c shl 8) xor TABLE[((c ushr 24) xor (x.toInt() and 0xFF)) and 0xFF]
        return c
    }

    private fun le16(b: ByteArray, at: Int, v: Int) {
        b[at] = v.toByte()
        b[at + 1] = (v shr 8).toByte()
    }

    private fun le32(b: ByteArray, at: Int, v: Int) {
        for (i in 0 until 4) b[at + i] = (v shr (8 * i)).toByte()
    }
}
