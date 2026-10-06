package org.folio.pdf
import android.os.Bundle
import android.graphics.Color
import android.os.Build
import android.view.ActionMode
import android.view.Menu
import android.view.MenuInflater
import android.view.View
import android.webkit.WebView
import android.widget.PopupMenu
import androidx.activity.OnBackPressedCallback
import org.folio.android.SelectionGate
import org.folio.android.applySavedTheme
import org.folio.android.prepareAppWebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
class MainActivity : TauriActivity() {
  override val handleBackNavigation = false
  private var readerBack: OnBackPressedCallback? = null
  private var webView: WebView? = null
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    prepareAppWebView(webView, BuildConfig.VERSION_CODE)
    webView.addJavascriptInterface(SelectionGate, "FolioSelection")
    applySavedTheme(this, webView)
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
    val content = findViewById<View>(android.R.id.content)
    applySavedTheme(this)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      // Hidden bars keep their space: hiding them with a tap must not resize the
      // WebView, which would rescale a fitted page.
      val bars = Insets.max(insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars()), insets.getInsets(WindowInsetsCompat.Type.displayCutout()))
      // Native owns the top/sides once. The PDF extends behind gesture navigation;
      // getSafeArea protects only interactive web controls at the bottom.
      view.setPadding(bars.left, bars.top, bars.right, 0)
      // Forward zeros rather than CONSUMED, retaining WebView keyboard updates.
      WindowInsetsCompat.Builder(insets).setInsets(types, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
  }
  // Selected PDF text has Folio's own Copy/Highlight/Comment menu, and WebView
  // would draw its floating toolbar on top. Editable fields and any other
  // selectable text keep the toolbar.
  override fun onWindowStartingActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
    val view = webView
    if (type != ActionMode.TYPE_FLOATING || view == null || view.onCheckIsTextEditor() || !SelectionGate.pdfText) return super.onWindowStartingActionMode(callback, type)
    val mode = SilentActionMode(callback, PopupMenu(this, view).menu, menuInflater)
    return if (callback.onCreateActionMode(mode, mode.menu)) mode else null
  }
  /** Keeps WebView's selection and handles without showing its toolbar. */
  private class SilentActionMode(private val callback: ActionMode.Callback, private val menu: Menu, private val inflater: MenuInflater) : ActionMode() {
    private var finished = false
    init { type = ActionMode.TYPE_FLOATING }
    override fun setTitle(title: CharSequence?) {}
    override fun setTitle(resId: Int) {}
    override fun setSubtitle(subtitle: CharSequence?) {}
    override fun setSubtitle(resId: Int) {}
    override fun setCustomView(view: View?) {}
    override fun invalidate() {}
    override fun finish() { if (!finished) { finished = true; callback.onDestroyActionMode(this) } }
    override fun getMenu(): Menu = menu
    override fun getTitle(): CharSequence? = null
    override fun getSubtitle(): CharSequence? = null
    override fun getCustomView(): View? = null
    override fun getMenuInflater(): MenuInflater = inflater
  }
}
