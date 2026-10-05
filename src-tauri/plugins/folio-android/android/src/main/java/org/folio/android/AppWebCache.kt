package org.folio.android

import android.content.Context
import android.webkit.WebSettings
import android.webkit.WebView

/** The APK supplies the interface. HTTP cache from an earlier installation
 * must not keep serving an old entry page after an in-place update. */
fun prepareAppWebView(webView: WebView, versionCode: Int) {
    webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
    val preferences = webView.context.getSharedPreferences("folio.interface-cache", Context.MODE_PRIVATE)
    if (preferences.getInt("version", -1) == versionCode) return
    // clearCache only clears web resources: never clear WebStorage, databases,
    // preferences or the private PDF/session directories.
    webView.clearCache(true)
    preferences.edit().putInt("version", versionCode).apply()
}
