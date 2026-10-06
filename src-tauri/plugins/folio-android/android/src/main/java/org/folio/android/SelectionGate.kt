package org.folio.android

import android.webkit.JavascriptInterface

/** PDF text has Folio's own Copy/Highlight/Comment menu; help, licences, notes
 * and dialogs keep Android's text toolbar. The page reports where each touch
 * starts (plugin init script), before a long press can begin a selection. */
object SelectionGate {
    @Volatile var pdfText = true
        private set
    @JavascriptInterface fun touched(pdf: Boolean) { pdfText = pdf }
}
