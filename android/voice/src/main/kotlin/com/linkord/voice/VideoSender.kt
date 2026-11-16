package com.linkord.voice

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.util.concurrent.Executors

/**
 * Our camera or screen as H.264 (Annex B) for the media socket: [flags][seq u16][codec on keyframes][frame], the
 * format every client decodes (voice.rs). The parameter sets go in front of every keyframe, so a viewer can start
 * from any of them; viewers ask for one when they join or lose frames ([requestKeyframe]).
 */
class VideoSender(
    private val width: Int,
    private val height: Int,
    private val fps: Int,
    private val bitrate: Int,
    private val send: (ByteArray) -> Unit,
) {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    val input: Surface
    private val thread = HandlerThread("linkord-video-enc").also { it.start() }
    @Volatile private var running = true
    private var config: ByteArray? = null
    private var codecName = "avc1.42e01f"
    private var seq = 0

    init {
        val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
            setInteger(MediaFormat.KEY_LATENCY, 1)
            // A still screen keeps sending (viewers drop a stream after 8 s without frames).
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 500_000)
        }
        codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        input = codec.createInputSurface()
        codec.start()
        Handler(thread.looper).post(::drain)
    }

    fun requestKeyframe() {
        runCatching { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    private fun drain() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            val i = runCatching { codec.dequeueOutputBuffer(info, 50_000) }.getOrElse { return }
            if (i < 0) continue
            val buf = codec.getOutputBuffer(i) ?: continue
            val data = ByteArray(info.size)
            buf.position(info.offset)
            buf.get(data)
            codec.releaseOutputBuffer(i, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                config = data
                codecName = codecString(data) ?: codecName
                continue
            }
            val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
            val frame = if (key) (config ?: ByteArray(0)) + data else data
            val name = codecName.toByteArray(Charsets.US_ASCII)
            val head = if (key) 4 + name.size else 3
            val out = ByteArray(head + frame.size)
            out[0] = if (key) 1 else 0
            out[1] = (seq shr 8).toByte()
            out[2] = seq.toByte()
            seq = (seq + 1) and 0xFFFF
            if (key) {
                out[3] = name.size.toByte()
                System.arraycopy(name, 0, out, 4, name.size)
            }
            System.arraycopy(frame, 0, out, head, frame.size)
            send(out)
        }
    }

    fun stop() {
        running = false
        runCatching { codec.signalEndOfInputStream() }
        thread.quitSafely()
        thread.join(500)
        runCatching { codec.stop() }
        codec.release()
        input.release()
    }

    companion object {
        /** "avc1.PPCCLL" from the SPS in the encoder's parameter sets. */
        fun codecString(config: ByteArray): String? {
            for (i in 0 until config.size - 7) {
                if (config[i].toInt() == 0 && config[i + 1].toInt() == 0 && config[i + 2].toInt() == 1 && (config[i + 3].toInt() and 0x1F) == 7) {
                    return "avc1.%02x%02x%02x".format(config[i + 4], config[i + 5], config[i + 6])
                }
            }
            return null
        }
    }
}

/** The camera (front by default) into a [VideoSender] (Camera2, nothing else to bundle). */
class CameraSource(private val context: Context, private val sender: VideoSender) {
    private val thread = HandlerThread("linkord-camera").also { it.start() }
    private val handler = Handler(thread.looper)
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    /** Your own camera on your tile, when it's on screen. */
    @Volatile private var preview: android.view.Surface? = null

    /** Shows (or stops showing) the camera on [surface] too; the capture session is rebuilt with it. */
    fun preview(surface: android.view.Surface?) {
        preview = surface
        handler.post { device?.let { configure(it) } }
    }

    private fun configure(camera: CameraDevice) {
        runCatching { session?.close() }
        val targets = listOfNotNull(sender.input, preview?.takeIf { it.isValid })
        runCatching {
            camera.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR, targets.map { OutputConfiguration(it) }, Executors.newSingleThreadExecutor(), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    session = s
                    val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply { targets.forEach { addTarget(it) } }.build()
                    runCatching { s.setRepeatingRequest(req, null, handler) }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {}
            }))
        }
    }

    @SuppressLint("MissingPermission")
    fun start(front: Boolean = true) {
        val cm = context.getSystemService(CameraManager::class.java)
        val id = cm.cameraIdList.firstOrNull {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == if (front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        } ?: cm.cameraIdList.firstOrNull() ?: return
        cm.openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                device = camera
                configure(camera)
            }

            override fun onDisconnected(camera: CameraDevice) = camera.close()
            override fun onError(camera: CameraDevice, error: Int) = camera.close()
        }, handler)
    }

    fun stop() {
        runCatching { session?.close() }
        runCatching { device?.close() }
        thread.quitSafely()
    }
}

/** The phone's screen into a [VideoSender] (MediaProjection; the app asks for it and runs the projection service). */
class ScreenSource(private val projection: MediaProjection, private val sender: VideoSender, private val dpi: Int) {
    private var display: VirtualDisplay? = null

    fun start(width: Int, height: Int) {
        projection.registerCallback(object : MediaProjection.Callback() {}, null)
        display = projection.createVirtualDisplay("linkord-screen", width, height, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, sender.input, null, null)
    }

    fun stop() {
        display?.release()
        projection.stop()
    }
}
