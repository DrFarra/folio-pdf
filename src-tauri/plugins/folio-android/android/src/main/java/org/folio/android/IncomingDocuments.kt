package org.folio.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.io.File
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
        require(unique.size <= 20) { "Importa un máximo de 20 PDF a la vez." }
        for (uri in unique) {
            require(uri.scheme in listOf("content", "file")) { "La aplicación no envió un archivo PDF accesible." }
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
            context.contentResolver.openInputStream(uri)?.use { input -> FileOutputStream(file).use { output ->
                val buffer = ByteArray(65536); var total = 0L
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    total += count; require(total <= 100L * 1024 * 1024) { "El PDF supera 100 MiB." }
                    output.write(buffer, 0, count)
                }
            } } ?: error("No se pudo leer el PDF. Vuelve a abrirlo desde la aplicación de origen.")
            require(file.inputStream().use { input ->
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
        if (intent?.action !in listOf(Intent.ACTION_VIEW, Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return
        // Read the Intent while the activity owns it; copy bytes off the UI thread.
        val uris = runCatching {
            val values = mutableListOf<Uri>()
            intent?.data?.let(values::add)
            if (intent?.action == Intent.ACTION_SEND) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(values::add)
            if (intent?.action == Intent.ACTION_SEND_MULTIPLE) IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(values::addAll)
            intent?.clipData?.let { clip -> for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(values::add) }
            values.distinct()
        }
        io.execute {
            val event = try {
                val incoming = uris.getOrThrow()
                require(incoming.isNotEmpty()) { "La aplicación no envió el archivo. Prueba a compartir el PDF con Folio." }
                val paths = JSArray(); importDocuments(context, incoming, intent?.flags ?: 0).forEach { paths.put(it.absolutePath) }
                JSObject().put("paths", paths)
            } catch (error: Exception) { JSObject().put("error", error.message ?: "No se pudo abrir el PDF recibido.") }
            val callback = listener
            if (callback == null) pending.add(event) else callback(event)
        }
    }
}
