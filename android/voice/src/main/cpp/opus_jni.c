// libopus for the voice module (com.linkord.voice.Opus): an encoder for our voice (mono, 48 kHz, 20 ms frames, the
// web client's settings: VoIP, 40 kbit/s, complexity 8) and a decoder per person / bot (mono voice, stereo music and
// stream audio). Handles are pointers kept as longs on the Kotlin side.
#include <jni.h>
#include <stdlib.h>
#include <opus.h>

#define MAX_PACKET 4000

JNIEXPORT jlong JNICALL Java_com_linkord_voice_Opus_encoderCreate(JNIEnv *env, jclass c, jint rate, jint channels, jint bitrate, jint complexity) {
    int err = 0;
    // Mono = our voice; stereo = a stream's sound, music quality.
    OpusEncoder *e = opus_encoder_create(rate, channels, channels == 2 ? OPUS_APPLICATION_AUDIO : OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK || !e) return 0;
    opus_encoder_ctl(e, OPUS_SET_BITRATE(bitrate));
    opus_encoder_ctl(e, OPUS_SET_COMPLEXITY(complexity));
    opus_encoder_ctl(e, OPUS_SET_SIGNAL(channels == 2 ? OPUS_SIGNAL_MUSIC : OPUS_SIGNAL_VOICE));
    // Voice goes over a websocket (TCP): packets arrive late, never lost, so no in-band FEC.
    return (jlong)(intptr_t)e;
}

JNIEXPORT jint JNICALL Java_com_linkord_voice_Opus_encode(JNIEnv *env, jclass c, jlong h, jshortArray pcm, jint frame, jbyteArray out) {
    OpusEncoder *e = (OpusEncoder *)(intptr_t)h;
    if (!e) return -1;
    jshort *in = (*env)->GetShortArrayElements(env, pcm, NULL);
    unsigned char buf[MAX_PACKET];
    int n = opus_encode(e, in, frame, buf, MAX_PACKET);
    (*env)->ReleaseShortArrayElements(env, pcm, in, JNI_ABORT);
    if (n > 0) (*env)->SetByteArrayRegion(env, out, 0, n, (const jbyte *)buf);
    return n;
}

JNIEXPORT void JNICALL Java_com_linkord_voice_Opus_encoderDestroy(JNIEnv *env, jclass c, jlong h) {
    if (h) opus_encoder_destroy((OpusEncoder *)(intptr_t)h);
}

JNIEXPORT jlong JNICALL Java_com_linkord_voice_Opus_decoderCreate(JNIEnv *env, jclass c, jint rate, jint channels) {
    int err = 0;
    OpusDecoder *d = opus_decoder_create(rate, channels, &err);
    return (err == OPUS_OK && d) ? (jlong)(intptr_t)d : 0;
}

// packet == null: a lost packet, concealed (PLC). fec: rebuild the previous packet from this one's FEC data.
JNIEXPORT jint JNICALL Java_com_linkord_voice_Opus_decode(JNIEnv *env, jclass c, jlong h, jbyteArray packet, jint len, jshortArray out, jint frame, jboolean fec) {
    OpusDecoder *d = (OpusDecoder *)(intptr_t)h;
    if (!d) return -1;
    jbyte *p = packet ? (*env)->GetByteArrayElements(env, packet, NULL) : NULL;
    jshort *o = (*env)->GetShortArrayElements(env, out, NULL);
    int n = opus_decode(d, (const unsigned char *)p, p ? len : 0, o, frame, fec ? 1 : 0);
    (*env)->ReleaseShortArrayElements(env, out, o, 0);
    if (p) (*env)->ReleaseByteArrayElements(env, packet, p, JNI_ABORT);
    return n;
}

JNIEXPORT void JNICALL Java_com_linkord_voice_Opus_decoderDestroy(JNIEnv *env, jclass c, jlong h) {
    if (h) opus_decoder_destroy((OpusDecoder *)(intptr_t)h);
}
