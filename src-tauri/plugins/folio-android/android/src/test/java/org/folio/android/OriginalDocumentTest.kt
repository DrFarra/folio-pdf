package org.folio.android

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class OriginalDocumentTest {
    class Documents : ContentProvider() {
        lateinit var file: File
        var readOnly = false
        var missing = false
        var failRestore = false
        var corruptNextSave = false
        var written = false
        var restores = 0
        override fun onCreate() = true
        override fun getType(uri: Uri) = "application/pdf"
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?) =
            MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply { addRow(arrayOf(file.name)) }
        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            if (missing) throw java.io.FileNotFoundException("Missing file")
            if (mode.contains('w') && readOnly) throw SecurityException("Solo lectura")
            if (mode == "wt" && failRestore) throw java.io.IOException("Provider offline")
            if (mode == "r" && written && corruptNextSave && file.readText().contains("EDITADO")) {
                corruptNextSave = false; file.writeText("%PDF-1.7\nError del proveedor\n%%EOF")
            }
            if (mode == "rw") written = true
            if (mode == "wt") restores++
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
        }
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    }
    private lateinit var context: Context
    private lateinit var provider: Documents
    private lateinit var source: File
    private val uri = Uri.parse("content://originals/123")
    private val before = "%PDF-1.7\nOriginal con contenido largo que se debe truncar\n%%EOF".toByteArray()
    private val after = "%PDF-1.7\nEDITADO\n%%EOF".toByteArray()
    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        provider = Documents()
        provider.file = File(context.cacheDir, "Apuntes.pdf").apply { writeBytes(before) }
        provider.attachInfo(context, ProviderInfo().apply { authority = "originals" })
        ShadowContentResolver.registerProviderInternal("originals", provider)
        source = importDocuments(context, listOf(uri)).files.single()
    }
    private fun edited(name: String = "save1") = File(File(context.filesDir, name).apply { mkdirs() }, "Apuntes.pdf").apply { writeBytes(after) }

    @Test fun savesInSameUriTruncatesAndPreservesBindingAfterReopen() {
        val output = edited()
        overwriteOriginal(context, source, output)
        assertArrayEquals(after, provider.file.readBytes())
        assertArrayEquals(before, source.readBytes()) // Local recovery snapshot.
        assertEquals(uri, readOriginal(File(output.absolutePath))!!.uri)
        val next = edited("save2").apply { writeText("%PDF-1.7\nSEGUNDA EDICION\n%%EOF") }
        overwriteOriginal(context, File(output.absolutePath), next)
        assertArrayEquals(next.readBytes(), provider.file.readBytes())
        assertEquals(1, context.cacheDir.listFiles()!!.count { it.extension == "pdf" })
        assertTrue(File(context.filesDir, "FolioRecovery").listFiles()!!.isEmpty())
    }
    @Test fun externalEditsAreNeverOverwritten() {
        val external = "%PDF-1.7\nCambio externo\n%%EOF".toByteArray()
        provider.file.writeBytes(external)
        val failure = runCatching { overwriteOriginal(context, source, edited()) }.exceptionOrNull()
        assertTrue(failure!!.message!!.contains("cambió fuera"))
        assertArrayEquals(external, provider.file.readBytes())
        assertEquals(0, provider.restores)
    }
    @Test fun missingWritePermissionRequestsAccessWithoutTouchingOriginal() {
        provider.readOnly = true
        assertTrue(runCatching { overwriteOriginal(context, source, edited()) }.exceptionOrNull() is OriginalAccessRequired)
        assertArrayEquals(before, provider.file.readBytes())
    }
    @Test fun legacyImportMustSelectMatchingOriginalBeforeItCanSave() {
        File(source.parentFile, source.name + ".origin.json").delete()
        assertTrue(runCatching { overwriteOriginal(context, source, edited()) }.exceptionOrNull() is OriginalAccessRequired)
        val selected = selectedOriginal(context, source, uri)
        overwriteOriginal(context, source, edited(), selected)
        assertArrayEquals(after, provider.file.readBytes())
    }
    @Test fun choosingAnotherPdfCannotOverwriteIt() {
        val other = "%PDF-1.7\nOTRO DOCUMENTO\n%%EOF".toByteArray()
        provider.file.writeBytes(other)
        assertTrue(runCatching { selectedOriginal(context, source, uri) }.isFailure)
        assertArrayEquals(other, provider.file.readBytes())
    }
    @Test fun failedVerificationRestoresOriginalAndKeepsEdits() {
        provider.corruptNextSave = true
        val output = edited()
        val failure = runCatching { overwriteOriginal(context, source, output) }.exceptionOrNull()
        assertTrue(failure!!.message!!.contains("Se restauró"))
        assertArrayEquals(before, provider.file.readBytes())
        assertArrayEquals(after, output.readBytes())
        assertEquals(1, provider.restores)
        assertTrue(File(context.filesDir, "FolioRecovery").listFiles()!!.isEmpty())
    }
    @Test fun failedRestoreKeepsThePreviousVersionAsADocument() {
        provider.corruptNextSave = true; provider.failRestore = true
        val failure = runCatching { overwriteOriginal(context, source, edited()) }.exceptionOrNull()
        assertTrue(failure is OriginalRecovered)
        val recovered = (failure as OriginalRecovered).file
        assertEquals("Apuntes (versión anterior).pdf", recovered.name)
        assertTrue(failure.message!!.contains("en la biblioteca como «Apuntes (versión anterior).pdf»"))
        assertArrayEquals(before, recovered.readBytes())
        assertEquals(File(context.filesDir, "FolioImports").canonicalPath, recovered.parentFile!!.parentFile!!.canonicalPath)
        assertTrue(File(context.filesDir, "FolioRecovery").listFiles()!!.isEmpty())
    }
    @Test fun movedOrDeletedOriginalIsReportedInsteadOfAskingForIt() {
        provider.missing = true
        val failure = runCatching { overwriteOriginal(context, source, edited()) }.exceptionOrNull()
        assertTrue(failure !is OriginalAccessRequired && failure!!.message!!.contains("No se encontró"))
    }
    @Test fun separatelySavedPdfRemainsLinkedForSubsequentSave() {
        val copy = edited()
        provider.file.writeBytes(after)
        rememberOriginal(copy, uri)
        val next = edited("next").apply { writeText("%PDF-1.7\nOTRA EDICION\n%%EOF") }
        overwriteOriginal(context, copy, next)
        assertArrayEquals(next.readBytes(), provider.file.readBytes())
    }
}
