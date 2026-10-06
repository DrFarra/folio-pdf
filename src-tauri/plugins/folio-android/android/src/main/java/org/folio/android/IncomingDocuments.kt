package org.folio.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executor

/** Both the system picker and external apps import through ContentResolver.
 * A content:// URI is a temporary grant, not a filesystem path. Keep our copy
 * so that recent documents still work after the sending app releases it. */
internal fun importDocuments(context: Context, uris: List<Uri>, flags: Int = 0): List<File> {
    val copied = mutableListOf<File>()
    try {
        val unique = uris.distinct()
        ensure(unique.size <= 20) { "Importa un máximo de 20 PDF a la vez." }
        for (uri in unique) {
            // A file:// URI would let another app make Folio read its own private files.
            ensure(uri.scheme == "content") { "La aplicación no envió un archivo PDF accesible." }
            var name = runCatching {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
                }
            }.getOrNull() ?: uri.lastPathSegment ?: "Documento.pdf"
            name = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\p{Cntrl}]"), "_").take(180)
            if (name.isBlank()) name = "Documento.pdf"
            if (!name.endsWith(".pdf", true)) name += ".pdf"
            val folder = File(context.filesDir, "FolioImports/${UUID.randomUUID()}").apply { mkdirs() }
            val file = File(folder, name); copied.add(file)
            val source = try { context.contentResolver.openInputStream(uri) }
                catch (_: SecurityException) { throw FolioError("Folio no tiene permiso para abrir este PDF. Ábrelo de nuevo desde la aplicación de origen.") }
                catch (_: FileNotFoundException) { throw FolioError("No se pudo leer el PDF. Comprueba que siga disponible y vuelve a intentarlo.") }
            source?.use { input -> FileOutputStream(file).use { output ->
                val buffer = ByteArray(65536); var total = 0L
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    total += count; ensure(total <= 100L * 1024 * 1024) { "El PDF supera 100 MiB." }
                    output.write(buffer, 0, count)
                }
            } } ?: throw FolioError("No se pudo leer el PDF. Vuelve a abrirlo desde la aplicación de origen.")
            ensure(file.inputStream().use { input ->
                val header = ByteArray(1024); val count = input.read(header)
                count > 0 && String(header, 0, count, Charsets.ISO_8859_1).contains("%PDF-")
            }) { "El archivo recibido no es un PDF." }
            retainDocumentAccess(context, uri, flags)
            rememberOriginal(file, uri)
        }
        return copied
    } catch (error: Exception) {
        copied.forEach { File(it.parentFile, it.name + ".origin.json").delete(); it.delete(); it.parentFile?.delete() }
        throw error
    }
}

/** Imports live in filesDir. Rust keeps saved copies and drafts in Tauri's app
 * data directory, which on Android is Context.dataDir rather than filesDir. */
internal fun privateFile(context: Context, path: String): File {
    val file = File(path).canonicalFile
    val roots = listOf(context.filesDir, File(context.dataDir, "exports"), File(context.dataDir, "drafts")).map { it.canonicalPath + File.separator }
    ensure(roots.any { file.path.startsWith(it) }) { "El archivo no pertenece a Folio." }
    ensure(file.isFile) { "El archivo ya no está disponible." }
    return file
}

/** Deletes the private copies that neither the library nor an open tab uses
 * ([keep]), then the document access Android kept only for their originals.
 * A copy written in the last minute may still be on its way to the reader. */
internal fun deleteUnusedCopies(context: Context, keep: Collection<String>, now: Long = System.currentTimeMillis()) {
    val kept = keep.mapNotNull { runCatching { File(it).canonicalFile.parentFile }.getOrNull() }.toSet()
    val (retained, unused) = listOf(File(context.filesDir, "FolioImports"), File(context.dataDir, "exports")).flatMap { it.listFiles().orEmpty().filter(File::isDirectory) }
        .partition { it.canonicalFile in kept || now - it.lastModified() < 60_000 }
    unused.forEach { it.deleteRecursively() }
    val originals = retained.flatMap { it.listFiles().orEmpty().filter { file -> file.name.endsWith(".origin.json") } }
        .mapNotNull { runCatching { readOriginal(File(it.parentFile, it.name.removeSuffix(".origin.json")))?.uri }.getOrNull() }.toSet()
    for (grant in context.contentResolver.persistedUriPermissions) if (grant.uri !in originals) {
        val flags = (if (grant.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or (if (grant.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
        runCatching { context.contentResolver.releasePersistableUriPermission(grant.uri, flags) }
    }
}

/** Queue on one worker until Rust is listening, including cold-start intents. */
internal class IncomingDocuments(private val context: Context, private val io: Executor) {
    private val pending = mutableListOf<JSObject>()
    private var listener: ((JSObject) -> Unit)? = null

    fun listen(callback: (JSObject) -> Unit) = io.execute {
        listener = callback
        pending.forEach(callback)
        pending.clear()
    }

    fun receive(intent: Intent?) {
        if (intent == null || intent.action !in listOf(Intent.ACTION_VIEW, Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return
        // Returning from Recents after Android ended the process replays the
        // launch intent: the PDF is already in the library.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        // Read the Intent while the activity owns it; copy bytes off the UI thread.
        val uris = runCatching {
            val values = mutableListOf<Uri>()
            intent.data?.let(values::add)
            if (intent.action == Intent.ACTION_SEND) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(values::add)
            if (intent.action == Intent.ACTION_SEND_MULTIPLE) IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(values::addAll)
            intent.clipData?.let { clip -> for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(values::add) }
            values.distinct()
        }
        io.execute {
            val event = try {
                val incoming = uris.getOrThrow()
                ensure(incoming.isNotEmpty()) { "La aplicación no envió el archivo. Prueba a compartir el PDF con Folio." }
                paths(importDocuments(context, incoming, intent.flags))
            } catch (error: Exception) { JSObject().put("error", userMessage(error, "No se pudo abrir el PDF recibido.")) }
            dispatch(event)
        }
    }

    /** Opens a PDF that Folio wrote itself, such as a recovered previous version. */
    fun deliver(files: List<File>) = io.execute { dispatch(paths(files)) }

    private fun paths(files: List<File>) = JSObject().put("paths", JSArray().apply { files.forEach { put(it.absolutePath) } })
    private fun dispatch(event: JSObject) {
        val callback = listener
        if (callback == null) pending.add(event) else callback(event)
    }
}
