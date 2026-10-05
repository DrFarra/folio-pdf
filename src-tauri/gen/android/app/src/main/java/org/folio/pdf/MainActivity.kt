package org.folio.pdf
import android.os.Bundle
import android.graphics.Color
import android.os.Build
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import org.folio.android.prepareAppWebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
class MainActivity : TauriActivity() {
  override val handleBackNavigation = false
  private var readerBack: OnBackPressedCallback? = null
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    prepareAppWebView(webView, BuildConfig.VERSION_CODE)
    readerBack?.remove()
    readerBack = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // Folio has an in-memory reader, not a browser history. Going back in
        // WebView or destroying the activity re-imports/reloads the document.
        webView.evaluateJavascript("window.dispatchEvent(new Event('folio:android-back', {cancelable: true}))") { unhandled ->
          if (unhandled == "true") moveTaskToBack(true)
        }
      }
    }.also { onBackPressedDispatcher.addCallback(this, it) }
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= 29) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    val content = findViewById<android.view.View>(android.R.id.content)
    content.setBackgroundColor(Color.WHITE)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = true
      isAppearanceLightNavigationBars = true
    }
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val bars = insets.getInsets(types)
      // Native owns the top/sides once. The PDF extends behind gesture navigation;
      // getSafeArea protects only interactive web controls at the bottom.
      view.setPadding(bars.left, bars.top, bars.right, 0)
      // Forward zeros rather than CONSUMED, retaining WebView keyboard updates.
      WindowInsetsCompat.Builder(insets).setInsets(types, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
