package org.folio.android

import android.content.Context
import android.webkit.WebSettings
import android.webkit.WebView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class AppWebCacheTest {
    private class RecordingWebView(context: Context) : WebView(context) {
        val clears = mutableListOf<Boolean>()
        override fun clearCache(includeDiskFiles: Boolean) { clears.add(includeDiskFiles) }
    }
    @Test fun updateClearsOnlyInterfaceCacheOnceAndPreservesSavedData() {
        val context = RuntimeEnvironment.getApplication()
        val reader = context.getSharedPreferences("reading", Context.MODE_PRIVATE)
        reader.edit().putInt("page", 17).commit()
        val pdf = File(context.filesDir, "saved.pdf").apply { writeText("%PDF-1.7 saved document") }
        val session = File(context.filesDir, "annotations.json").apply { writeText("{\"page\":17}") }
        val database = context.openOrCreateDatabase("documents.db", Context.MODE_PRIVATE, null)
        database.execSQL("CREATE TABLE library (name TEXT)")
        database.execSQL("INSERT INTO library VALUES ('saved.pdf')")
        val view = RecordingWebView(context)
        prepareAppWebView(view, 8006)
        prepareAppWebView(view, 8006)
        assertEquals(listOf(true), view.clears)
        prepareAppWebView(view, 8007)
        prepareAppWebView(view, 8007)
        assertEquals(listOf(true, true), view.clears)
        assertEquals(WebSettings.LOAD_NO_CACHE, view.settings.cacheMode)
        assertFalse(view.settings.supportZoom())
        assertFalse(view.settings.builtInZoomControls)
        assertFalse(view.settings.displayZoomControls)
        assertEquals(17, reader.getInt("page", 0))
        assertEquals("%PDF-1.7 saved document", pdf.readText())
        assertEquals("{\"page\":17}", session.readText())
        database.rawQuery("SELECT name FROM library", null).use { assertTrue(it.moveToFirst()); assertEquals("saved.pdf", it.getString(0)) }
        database.close(); view.destroy()
    }
    @Test fun reopeningSameVersionDoesNotClearAgain() {
        val context = RuntimeEnvironment.getApplication()
        prepareAppWebView(RecordingWebView(context), 8007)
        val next = RecordingWebView(context)
        prepareAppWebView(next, 8007)
        assertTrue(next.clears.isEmpty())
        assertEquals(WebSettings.LOAD_NO_CACHE, next.settings.cacheMode)
        next.destroy()
    }
}
