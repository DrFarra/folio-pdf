package org.folio.android

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.AtomicFile
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

/** A message written for the user. Android's own exception texts are English
 * and technical: they only reach Logcat. */
internal open class FolioError(message: String, cause: Throwable? = null) : Exception(message, cause)
internal inline fun ensure(value: Boolean, message: () -> String) { if (!value) throw FolioError(message()) }
internal fun userMessage(error: Throwable, fallback: String): String {
    Log.w("Folio", fallback, error)
    return when (error) {
        is FolioError -> error.message ?: fallback
        is ActivityNotFoundException -> "Este dispositivo no tiene un selector de archivos disponible."
        else -> fallback
    }
}

internal data class OriginalDocument(val uri: Uri, val digest: String)
internal class OriginalAccessRequired : FolioError("Selecciona el PDF original para permitir su escritura.")
/** The original could not be restored after a failed write. [file] holds the
 * version it had before and is opened as a new library document. */
internal class OriginalRecovered(val file: File, message: String, cause: Throwable) : FolioError(message, cause)

internal fun pdfDigest(input: InputStream): String = input.use {
    val hash = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(65536); var total = 0L
    while (true) {
        val count = it.read(buffer); if (count < 0) break
        total += count; ensure(total <= 128L * 1024 * 1024) { "El PDF supera 128 MiB." }
        hash.update(buffer, 0, count)
    }
    hash.digest().joinToString("") { byte -> "%02x".format(byte) }
}

private fun originFile(file: File) = File(file.parentFile, file.name + ".origin.json")
internal fun readOriginal(file: File): OriginalDocument? {
    val metadata = originFile(file)
    if (!metadata.exists()) return null // Imports from earlier app versions.
    val value = JSONObject(AtomicFile(metadata).openRead().bufferedReader().use { it.readText() })
    val uri = Uri.parse(value.getString("uri"))
    // Earlier versions also kept file:// origins; those are chosen again.
    if (uri.scheme != "content") return null
    return OriginalDocument(uri, value.getString("digest"))
}

internal fun rememberOriginal(file: File, uri: Uri, digest: String = pdfDigest(file.inputStream())) {
    val atomic = AtomicFile(originFile(file))
    val output = atomic.startWrite()
    try {
        output.write(JSONObject().put("uri", uri.toString()).put("digest", digest).toString().toByteArray())
        atomic.finishWrite(output)
    } catch (error: Exception) { atomic.failWrite(output); throw error }
}

internal fun retainDocumentAccess(context: Context, uri: Uri, flags: Int) {
    if (flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION == 0) return
    val grants = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    if (grants != 0) runCatching { context.contentResolver.takePersistableUriPermission(uri, grants) }
}

/** A chosen original must match the version opened, including legacy imports.
 * Never guess a filesystem path from content:// or overwrite by filename. */
internal fun selectedOriginal(context: Context, source: File, uri: Uri): OriginalDocument {
    ensure(uri.scheme == "content") { "Elige un archivo PDF accesible." }
    val expected = readOriginal(source)?.digest ?: pdfDigest(source.inputStream())
    val actual = context.contentResolver.openInputStream(uri)?.let(::pdfDigest) ?: throw FolioError("No se pudo leer el PDF elegido.")
    ensure(actual == expected) { "El archivo elegido no coincide con el PDF que abriste, o cambió fuera de Folio. Abre la versión actual o usa Guardar una copia." }
    return OriginalDocument(uri, expected)
}

/** Provider writes are not atomic. Keep a durable backup, check for external
 * edits before truncation, verify the result and restore on a failed write. */
internal fun overwriteOriginal(context: Context, source: File, edited: File, selected: OriginalDocument? = null) {
    val original = selected ?: readOriginal(source) ?: throw OriginalAccessRequired()
    val resolver = context.contentResolver
    val descriptor = try { resolver.openFileDescriptor(original.uri, "rw") ?: throw OriginalAccessRequired() }
        catch (_: SecurityException) { throw OriginalAccessRequired() }
        catch (_: FileNotFoundException) {
            // Providers report a missing document and a missing write grant alike.
            if (runCatching { resolver.openInputStream(original.uri)?.close() }.exceptionOrNull() is FileNotFoundException)
                throw FolioError("No se encontró el PDF original; puede que se haya movido o eliminado. Usa Guardar una copia.")
            throw OriginalAccessRequired()
        }
    val backup = File(File(context.filesDir, "FolioRecovery").apply { mkdirs() }, "${UUID.randomUUID()}.pdf")
    var writing = false
    var restored = false
    try {
        descriptor.use { fd ->
            // rw opens without truncation. A non-seekable provider fails here,
            // before we change a single byte of the user's original.
            ParcelFileDescriptor.AutoCloseOutputStream(fd).use { output ->
            output.channel.position(0)
            resolver.openInputStream(original.uri)?.use { input -> backup.outputStream().use { copy ->
                val buffer = ByteArray(65536); var total = 0L
                while (true) { val count = input.read(buffer); if (count < 0) break
                    total += count; ensure(total <= 128L * 1024 * 1024) { "El PDF supera 128 MiB." }; copy.write(buffer, 0, count) }
                copy.fd.sync()
            } } ?: throw FolioError("No se pudo comprobar el original. No se ha modificado.")
            ensure(pdfDigest(backup.inputStream()) == original.digest) { "El PDF cambió fuera de Folio. Abre la versión actual o usa Guardar una copia para conservar tus cambios." }
            val expected = pdfDigest(edited.inputStream())
            rememberOriginal(backup, original.uri, original.digest)
            rememberOriginal(edited, original.uri, expected)
            writing = true
            output.channel.truncate(0)
            edited.inputStream().use { it.copyTo(output) }
            output.flush(); fd.fileDescriptor.sync()
            fd.checkError()
            }
        }
        val actual = resolver.openInputStream(original.uri)?.let(::pdfDigest)
        check(actual == pdfDigest(edited.inputStream())) { "El PDF guardado no coincide con los cambios." }
    } catch (error: Exception) {
        if (writing) {
            restored = runCatching {
                resolver.openOutputStream(original.uri, "wt")?.use { out -> backup.inputStream().use { it.copyTo(out) } }
                    ?: error("No se pudo restaurar")
                check(resolver.openInputStream(original.uri)?.let(::pdfDigest) == original.digest)
            }.isSuccess
            if (restored) throw FolioError("No se pudo guardar. Se restauró el PDF original; tus cambios siguen en Folio.", error)
            // The only intact copy must not stay hidden in private storage.
            val recovered = File(File(context.filesDir, "FolioImports/${UUID.randomUUID()}").apply { mkdirs() }, "${source.nameWithoutExtension} (versión anterior).pdf")
            if (backup.renameTo(recovered)) {
                originFile(backup).delete()
                throw OriginalRecovered(recovered, "No se pudo guardar y el original puede estar dañado. La versión anterior se abrió como «${recovered.name}»; tus cambios siguen en Folio.", error)
            }
            recovered.parentFile?.delete()
            throw FolioError("No se pudo guardar y el original puede estar dañado. Tus cambios siguen en Folio; usa Guardar una copia para conservarlos.", error)
        }
        if (error is java.io.IOException) throw FolioError("La app donde está guardado este PDF no permite modificarlo. El original no cambió; usa Guardar una copia.", error)
        throw error
    } finally {
        if (!writing || restored) { originFile(backup).delete(); backup.delete() }
    }
    originFile(backup).delete(); backup.delete()
}
