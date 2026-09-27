import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeSimulatorTest
import org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeTest
import org.gradle.api.tasks.testing.logging.TestExceptionFormat

plugins {
    kotlin("multiplatform")
    id("com.android.library")
}

group = "dev.freellmrouter"
version = "0.1.0"

val ktorVersion = "3.3.3"
val coroutinesVersion = "1.10.2"
val serializationVersion = "1.9.0"

kotlin {
    androidTarget {
        publishLibraryVariants("release")
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
    jvm {
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        target.binaries.framework {
            baseName = "FreeLlmRouter"
            isStatic = false // 동적 프레임워크: 링크 단계에서 iOS SDK 심볼까지 확인된다
        }
    }
    macosArm64()

    sourceSets {
        commonMain.dependencies {
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
            api("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
            // 공개 API(KtorTransport, createDefaultHttpClient)가 HttpClient 를 드러내므로 api
            api("io.ktor:ktor-client-core:$ktorVersion")
        }
        androidMain.dependencies {
            implementation("io.ktor:ktor-client-okhttp:$ktorVersion")
        }
        jvmMain.dependencies {
            implementation("io.ktor:ktor-client-okhttp:$ktorVersion")
        }
        appleMain.dependencies {
            implementation("io.ktor:ktor-client-darwin:$ktorVersion")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
        }
    }
}

android {
    namespace = "dev.freellmrouter"
    compileSdk = 35
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// ── 테스트 환경 ─────────────────────────────────────────
// spec/ 을 복사하지 않고 그대로 읽는다 (SPEC 8.1). FLR_SPEC_DIR 로 경로를 넘긴다.
val specDir: String = System.getenv("FLR_SPEC_DIR") ?: rootDir.resolve("../spec").canonicalPath

// -Pflr.slow / -Pflr.case=<name> / -Pflr.mockUrl=<url> / -Pflr.requireHttp 또는 같은 이름의 환경변수
fun flrEnv(): Map<String, String> {
    val out = linkedMapOf("FLR_SPEC_DIR" to specDir)
    fun pick(env: String, prop: String, flag: Boolean = false) {
        val p = providers.gradleProperty(prop).orNull
        val v = when {
            p != null -> if (flag && p.isEmpty()) "1" else p
            else -> System.getenv(env)
        }
        if (!v.isNullOrEmpty()) out[env] = v
    }
    pick("FLR_SLOW", "flr.slow", flag = true)
    pick("FLR_CASE", "flr.case")
    pick("FLR_MOCK_URL", "flr.mockUrl")
    pick("FLR_REQUIRE_HTTP", "flr.requireHttp", flag = true)
    pick("FLR_NODE", "flr.node")
    return out
}

tasks.withType<AbstractTestTask>().configureEach {
    // 모의 서버·spec 파일이 외부 입력이라 항상 다시 돈다
    outputs.upToDateWhen { false }
    testLogging {
        showStandardStreams = true
        events("passed", "skipped", "failed")
        exceptionFormat = TestExceptionFormat.FULL
    }
}

tasks.named<Test>("jvmTest") {
    maxHeapSize = "1g"
    doFirst {
        flrEnv().forEach { (k, v) -> environment(k, v) }
        // 라이브 스모크는 --tests '*LiveSmokeTest*' 로 지정했을 때만 돈다 (일반 실행과 분리, spec/live-smoke.md)
        val cli = (filter as org.gradle.api.internal.tasks.testing.filter.DefaultTestFilter).commandLineIncludePatterns
        if (cli.none { "LiveSmoke" in it }) filter.excludeTestsMatching("*LiveSmokeTest")
    }
}

tasks.withType<KotlinNativeTest>().configureEach {
    doFirst { flrEnv().forEach { (k, v) -> environment(k, v) } }
}

// iOS 시뮬레이터 런타임이 없으므로 기본으로 끈다. 켜려면 -Pflr.iosSimTests
tasks.withType<KotlinNativeSimulatorTest>().configureEach {
    enabled = providers.gradleProperty("flr.iosSimTests").isPresent
}
