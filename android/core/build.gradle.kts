import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Plain Kotlin (no Android): models, REST, the gateway client, the store and the markdown parser, so all of it is
// unit-tested on the JVM in seconds.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.collections.immutable)
    api(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

// One line per test as it finishes, so the box's runner shows progress.
tasks.withType<Test>().configureEach { testLogging { events("passed", "skipped", "failed") } }
