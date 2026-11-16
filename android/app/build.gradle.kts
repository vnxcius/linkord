import java.util.Properties
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing: a keystore outside the repo (CLAUDE.md, "Updater and release"). Without it the release build is
// unsigned, which is fine for checking that it builds but can't be installed or published.
val signing = Properties().apply {
    val f = file(System.getenv("LINKORD_ANDROID_SIGNING") ?: "${System.getProperty("user.home")}/.config/linkord/android-release.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Debug builds talk to a local server: the emulator reaches the PC at 10.0.2.2, a phone on the same Wi-Fi needs the
// PC's address (gradle -Plinkord.devServer=http://192.168.0.5:7700).
val devServer = (findProperty("linkord.devServer") as String?) ?: "http://10.0.2.2:7700"

android {
    namespace = "com.linkord.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.linkord.app"
        minSdk = 29
        targetSdk = 37
        versionCode = 3
        versionName = "0.1.1"
        buildConfigField("String", "DEFAULT_SERVER", "\"https://linkord.app\"")
        buildConfigField("String", "DIRECT_SERVER", "\"https://direct.example.com:8443\"")
        // Addresses this server had before: links to them in old messages still open here.
        buildConfigField("String", "FORMER_SERVERS", "\"https://old.example.com\"")
        resValue("string", "app_name", "Linkord")
        manifestPlaceholders["authScheme"] = "linkord"
    }

    signingConfigs {
        if (signing.isNotEmpty()) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("String", "DEFAULT_SERVER", "\"$devServer\"")
            buildConfigField("String", "DIRECT_SERVER", "\"\"")
            resValue("string", "app_name", "Linkord Dev")
            manifestPlaceholders["authScheme"] = "linkord-dev"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
            ndk { abiFilters += listOf("arm64-v8a") }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }

    testOptions {
        // Screens are rendered on the JVM (Robolectric's native graphics) and saved as pictures: app/build/screens.
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("robolectric.graphicsMode", "NATIVE")
            it.systemProperty("roborazzi.test.record", "true")
        }
    }

    packaging {
        resources.excludes += listOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":designsystem"))
    implementation(project(":voice"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.splashscreen)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.ui)
    implementation(libs.androidx.media3.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.coil.gif)
    implementation(libs.coil.svg)
    // Notifications while the app is closed (data/Push.kt). No google-services plugin: the server hands out the settings.
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}

// Assets shared with the web client, made at build time so there is one source for every client:
// - the translations, app/src/lib/locales/pt-BR.ts as i18n/pt-BR.json (scripts/gen-strings.mjs; needs Node 22+ on the
//   PATH, or -Plinkord.node=/path/to/node);
// - the badge art, app/src/assets/badges/*.svg as badges/;
// - the call sounds (the owner's WAVs and the ringtones), app/src/assets/sounds as sounds/.
abstract class GenAssets : DefaultTask() {
    @get:InputFile abstract val dictionary: RegularFileProperty
    @get:InputFile abstract val script: RegularFileProperty
    @get:InputDirectory abstract val badges: DirectoryProperty
    @get:InputDirectory abstract val sounds: DirectoryProperty
    @get:Input abstract val node: Property<String>
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val exec: ExecOperations
    @get:Inject abstract val fs: FileSystemOperations

    @TaskAction
    fun run() {
        val out = outputDir.get().asFile
        exec.exec { commandLine(node.get(), script.get().asFile.absolutePath, out.absolutePath) }
        fs.copy {
            from(badges) { include("*.svg") }
            into(out.resolve("badges"))
        }
        fs.copy {
            from(sounds) { include("join.wav", "leave.wav", "disconnect.wav", "mute.wav", "unmute.wav", "deafen.wav", "undeafen.wav", "ring-incoming.mp3", "ring-outgoing.mp3", "message.wav", "christmas/*.mp3") }
            into(out.resolve("sounds"))
        }
    }
}

val genAssets = tasks.register<GenAssets>("genAssets") {
    dictionary.set(rootProject.file("../app/src/lib/locales/pt-BR.ts"))
    script.set(rootProject.file("scripts/gen-strings.mjs"))
    badges.set(rootProject.file("../app/src/assets/badges"))
    sounds.set(rootProject.file("../app/src/assets/sounds"))
    node.set((findProperty("linkord.node") as String?) ?: "node")
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(genAssets, GenAssets::outputDir)
    }
}
