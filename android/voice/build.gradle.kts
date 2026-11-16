// Voice: libopus through the NDK (JNI in src/main/cpp), the voice/media sockets, the jitter buffer and mixer, the
// voice gate and the audio devices (AudioRecord/AudioTrack on the voice-communication path, so the phone's own echo
// cancelling, noise suppression and gain control apply).
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "com.linkord.voice"
    compileSdk = 37
    ndkVersion = "29.0.14206865"
    defaultConfig {
        minSdk = 29
        // Phones (arm64) and the emulator (x86_64).
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=none") } }
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.31.6"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
}
