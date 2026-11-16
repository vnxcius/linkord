package com.linkord.voice

/** libopus (src/main/cpp/opus_jni.c). */
object Opus {
    init {
        System.loadLibrary("linkord_voice")
    }

    @JvmStatic external fun encoderCreate(rate: Int, channels: Int, bitrate: Int, complexity: Int): Long
    @JvmStatic external fun encode(handle: Long, pcm: ShortArray, frame: Int, out: ByteArray): Int
    @JvmStatic external fun encoderDestroy(handle: Long)
    @JvmStatic external fun decoderCreate(rate: Int, channels: Int): Long
    @JvmStatic external fun decode(handle: Long, packet: ByteArray?, len: Int, out: ShortArray, frame: Int, fec: Boolean): Int
    @JvmStatic external fun decoderDestroy(handle: Long)
}

/** 20 ms at 48 kHz: one Opus frame, the unit of everything here. */
const val RATE = 48_000
const val FRAME = 960
