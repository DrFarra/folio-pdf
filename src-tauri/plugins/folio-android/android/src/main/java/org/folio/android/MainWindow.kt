package org.folio.android

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.view.View
import android.webkit.WebView
import androidx.core.view.WindowCompat

private fun preferences(context: Context) = context.getSharedPreferences("folio.window", Context.MODE_PRIVATE)
internal fun savedTheme(context: Context) = preferences(context).getString("theme", "system")
internal fun saveTheme(context: Context, theme: String) = preferences(context).edit().putString("theme", theme).apply()
internal fun isDark(context: Context, theme: String?) = theme == "dark" || theme != "light" && context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
// --bg of the library and --surface of the reader header in src/styles.css.
private fun libraryBackground(dark: Boolean) = if (dark) Color.rgb(30, 33, 43) else Color.rgb(244, 245, 247)
internal fun readerBackground(dark: Boolean) = if (dark) Color.rgb(42, 46, 59) else Color.WHITE

/** The native strip under the status bar continues the screen below it. */
internal fun applyWindowTheme(activity: Activity, dark: Boolean, color: Int) {
    activity.findViewById<View>(android.R.id.content).setBackgroundColor(color)
    WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark }
}

/** Folio opens on the library. The web reports its theme only after loading, so
 * the window starts with the last one it set, or the system's until then. */
fun applySavedTheme(activity: Activity, webView: WebView? = null) {
    val dark = isDark(activity, savedTheme(activity))
    applyWindowTheme(activity, dark, libraryBackground(dark))
    webView?.setBackgroundColor(libraryBackground(dark))
}
