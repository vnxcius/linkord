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
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            private var idle: Job? = null
            override fun onStart(owner: LifecycleOwner) {
                idle?.cancel()
                session.gateway.setForeground(true)
                session.gateway.wake()
            }

            override fun onStop(owner: LifecycleOwner) {
                session.gateway.setForeground(false)
                // Without push yet, the socket stays open a while in the background (messages keep arriving, a
                // quick return resumes), then closes to spare the battery; coming back reconnects.
                idle = session.scope.launch {
                    delay(5 * 60_000)
                    session.gateway.disconnect()
                }
            }
        })
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
