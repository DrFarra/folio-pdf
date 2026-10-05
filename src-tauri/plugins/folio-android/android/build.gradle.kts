plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "org.folio.android"
    compileSdk = 36
    defaultConfig { minSdk = 26 }
    testOptions { unitTests.isIncludeAndroidResources = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8 } }
dependencies {
    implementation("com.google.android.gms:play-services-auth:22.0.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
}
