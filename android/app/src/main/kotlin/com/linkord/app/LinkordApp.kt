package com.linkord.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.gif.AnimatedImageDecoder
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import com.linkord.app.data.Session
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class LinkordApp : Application(), SingletonImageLoader.Factory {
    lateinit var session: Session
        private set

    override fun onCreate() {
        super.onCreate()
        session = Session(this)
        session.reporter.install()
        session.start()
        watchNetwork()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            private var idle: Job? = null
            override fun onStart(owner: LifecycleOwner) {
                idle?.cancel()
                session.gateway.setForeground(true)
                session.gateway.wake()
                session.calls.foregroundChanged(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                session.gateway.setForeground(false)
                session.calls.foregroundChanged(false)
                // Without push yet, the socket stays open a while in the background (messages keep arriving, a
                // quick return resumes), then closes to spare the battery; coming back reconnects.
                idle = session.scope.launch {
                    delay(5 * 60_000)
                    session.gateway.disconnect()
                }
            }
        })
    }

    /**
     * A switch to another network (Wi-Fi <-> mobile data, or back online) resumes the gateway on it right away: the old
     * socket is dead without knowing it, and a retry could be waiting out a long backoff. The first callback is the
     * network we already have.
     */
    private fun watchNetwork() {
        val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return
        runCatching {
            cm.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
                private var seen = false
                private var current: android.net.Network? = null
                override fun onAvailable(network: android.net.Network) {
                    val changed = seen && network != current
                    seen = true
                    current = network
                    if (changed) session.scope.launch { session.gateway.networkChanged() }
                }

                override fun onLost(network: android.net.Network) {
                    // Back online after this, on any network, counts as a change.
                    if (current == network) current = null
                }
            })
        }
    }

    override fun newImageLoader(context: android.content.Context): ImageLoader = ImageLoader.Builder(context)
        .components {
            add(OkHttpNetworkFetcherFactory(callFactory = { session.http }))
            add(AnimatedImageDecoder.Factory())
            add(coil3.svg.SvgDecoder.Factory())
        }
        .crossfade(false)
        .build()
}

val android.content.Context.session: Session get() = (applicationContext as LinkordApp).session
