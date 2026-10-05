package org.folio.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

internal data class OriginalDocument(val uri: Uri, val digest: String)
internal class OriginalAccessRequired : Exception("Selecciona el PDF original para permitir su escritura.")

internal fun pdfDigest(input: InputStream): String = input.use {
    val hash = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(65536); var total = 0L
    while (true) {
        val count = it.read(buffer); if (count < 0) break
        total += count; require(total <= 128L * 1024 * 1024) { "El PDF supera 128 MiB." }
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
    require(uri.scheme in listOf("content", "file")) { "El origen del PDF no es válido." }
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
    require(uri.scheme in listOf("content", "file")) { "Elige un archivo PDF accesible." }
    val expected = readOriginal(source)?.digest ?: pdfDigest(source.inputStream())
    val actual = context.contentResolver.openInputStream(uri)?.let(::pdfDigest) ?: error("No se pudo leer el PDF elegido.")
    require(actual == expected) { "El archivo elegido no coincide con el PDF que abriste, o cambió fuera de Folio. Abre la versión actual o usa Guardar una copia." }
    return OriginalDocument(uri, expected)
}

/** Provider writes are not atomic. Keep a durable backup, check for external
 * edits before truncation, verify the result and restore on a failed write. */
internal fun overwriteOriginal(context: Context, source: File, edited: File, selected: OriginalDocument? = null) {
    val original = selected ?: readOriginal(source) ?: throw OriginalAccessRequired()
    val resolver = context.contentResolver
    val descriptor = try { resolver.openFileDescriptor(original.uri, "rw") ?: throw OriginalAccessRequired() }
        catch (_: SecurityException) { throw OriginalAccessRequired() }
        catch (_: java.io.FileNotFoundException) { throw OriginalAccessRequired() }
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
                    total += count; require(total <= 128L * 1024 * 1024) { "El PDF supera 128 MiB." }; copy.write(buffer, 0, count) }
                copy.fd.sync()
            } } ?: error("No se pudo comprobar el original. No se ha modificado.")
            require(pdfDigest(backup.inputStream()) == original.digest) { "El PDF cambió fuera de Folio. Abre la versión actual o usa Guardar una copia para conservar tus cambios." }
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
        check(actual == pdfDigest(edited.inputStream())) { "El proveedor no confirmó todos los cambios." }
    } catch (error: Exception) {
        if (writing) {
            restored = runCatching {
                resolver.openOutputStream(original.uri, "wt")?.use { out -> backup.inputStream().use { it.copyTo(out) } }
                    ?: error("No se pudo restaurar")
                check(resolver.openInputStream(original.uri)?.let(::pdfDigest) == original.digest)
            }.isSuccess
            throw IllegalStateException(if (restored) "No se pudo guardar. Se restauró el PDF original; tus cambios siguen en Folio."
                else "No se pudo completar el guardado ni restaurar el original. Folio conserva el PDF anterior y tus cambios. Usa Guardar una copia para guardar los cambios.", error)
        }
        if (error is java.io.IOException) throw IllegalStateException("Este proveedor no permite guardar en el original. No se ha modificado; usa Guardar una copia.", error)
        throw error
    } finally {
        if (!writing || restored) { originFile(backup).delete(); backup.delete() }
    }
    originFile(backup).delete(); backup.delete()
}
