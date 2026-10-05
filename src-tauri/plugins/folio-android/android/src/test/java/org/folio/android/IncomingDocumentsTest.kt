package org.folio.android

import android.content.ClipData
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import app.tauri.plugin.JSObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.io.FileNotFoundException
import java.util.ArrayDeque
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class IncomingDocumentsTest {
    class Downloads : ContentProvider() {
        val files = mutableMapOf<String, File>()
        override fun onCreate() = true
        override fun getType(uri: Uri) = "application/pdf"
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?) =
            MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply { files[uri.path]?.let { addRow(arrayOf(it.name)) } }
        override fun openFile(uri: Uri, mode: String) = ParcelFileDescriptor.open(files[uri.path] ?: throw FileNotFoundException("Permiso de lectura no disponible"), ParcelFileDescriptor.MODE_READ_ONLY)
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    }
    private lateinit var context: Context
    private lateinit var provider: Downloads
    private lateinit var incoming: IncomingDocuments
    private val jobs = ArrayDeque<Runnable>()
    private val received = mutableListOf<JSObject>()
    private val pdf = "%PDF-1.7\nDocumento de prueba\n%%EOF".toByteArray()
    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        provider = Downloads()
        provider.attachInfo(context, ProviderInfo().apply { authority = "downloads" })
        ShadowContentResolver.registerProviderInternal("downloads", provider)
        incoming = IncomingDocuments(context, Executor { jobs.add(it) })
    }
    private fun flush() { while (jobs.isNotEmpty()) jobs.removeFirst().run() }
    private fun uri(id: Int, name: String = "Apuntes $id.pdf", bytes: ByteArray = pdf): Uri {
        val file = File(File(context.cacheDir, "source$id").apply { mkdirs() }, name).apply { writeBytes(bytes) }
        provider.files["/$id"] = file
        return Uri.parse("content://downloads/$id") // Providers commonly omit the extension.
    }
    private fun view(uri: Uri) = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    private fun copies(event: JSObject) = event.getJSONArray("paths").let { paths -> (0 until paths.length()).map { File(paths.getString(it)) } }

    @Test fun coldStartWaitsForListenerAndKeepsIndependentCopy() {
        val source = uri(1, "Neumología.pdf")
        incoming.receive(view(source)); flush()
        assertTrue(received.isEmpty())
        incoming.listen(received::add); flush()
        assertEquals(1, received.size)
        val copy = copies(received.single()).single()
        assertEquals("Neumología.pdf", copy.name)
        provider.files["/1"]!!.delete(); provider.files.clear()
        assertArrayEquals(pdf, copy.readBytes())
        incoming.listen(received::add); flush()
        assertEquals("Drained events must not replay", 1, received.size)
    }
    @Test fun warmOpenAndShareKeepArrivalOrderAndDeduplicateUris() {
        incoming.listen(received::add)
        incoming.receive(view(uri(1)))
        val shared = uri(2)
        incoming.receive(Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, shared).apply { clipData = ClipData.newRawUri("PDF", shared) })
        flush()
        assertEquals(listOf("Apuntes 1.pdf", "Apuntes 2.pdf"), received.map { copies(it).single().name })
    }
    @Test fun multipleShareAndClipOnlyViewAreSupported() {
        val first = uri(1); val second = uri(2)
        incoming.receive(Intent(Intent.ACTION_SEND_MULTIPLE).setType("application/pdf").putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(first, second)))
        incoming.receive(Intent(Intent.ACTION_VIEW).setType("application/pdf").apply { clipData = ClipData.newRawUri("PDF", second) })
        incoming.listen(received::add); flush()
        assertEquals(2, copies(received[0]).size)
        assertEquals("Apuntes 2.pdf", copies(received[1]).single().name)
    }
    @Test fun missingGrantReportsErrorAndNextOpenStillWorks() {
        incoming.listen(received::add)
        incoming.receive(view(Uri.parse("content://downloads/missing")))
        incoming.receive(view(uri(1))); flush()
        assertTrue(received[0].has("error"))
        assertEquals(1, copies(received[1]).size)
    }
    @Test fun malformedPdfIsRejectedAndPartialCopiesAreRemoved() {
        incoming.listen(received::add)
        val first = uri(1); val bad = uri(2, "Falso.pdf", "No es un PDF".toByteArray())
        incoming.receive(Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(first, bad))); flush()
        assertTrue(received.single().getString("error").contains("no es un PDF"))
        assertEquals(0, File(context.filesDir, "FolioImports").walkTopDown().count { it.isFile })
    }
    @Test fun regularLaunchIsIgnoredAndMissingAttachmentIsExplained() {
        incoming.listen(received::add); incoming.receive(Intent(Intent.ACTION_MAIN)); flush()
        assertTrue(received.isEmpty())
        incoming.receive(Intent(Intent.ACTION_SEND).setType("application/pdf")); flush()
        assertTrue(received.single().has("error"))
    }
}
