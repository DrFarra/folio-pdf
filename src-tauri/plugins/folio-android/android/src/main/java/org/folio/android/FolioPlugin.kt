package org.folio.android

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.*
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.*
import app.tauri.plugin.*
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg class PickArgs { var multiple: Boolean = true }
@InvokeArg class PathArgs { lateinit var path: String }
@InvokeArg class SaveOriginalArgs { lateinit var path: String; lateinit var source: String }
@InvokeArg class ThemeArgs { var theme: String = "light"; var background: String? = null }
@InvokeArg class ChromeArgs { var visible: Boolean = true }
@InvokeArg class KeepAwakeArgs { var on: Boolean = false }
@InvokeArg class HapticArgs { var kind: String = "light" }
@InvokeArg class UrlArgs { lateinit var url: String }
@InvokeArg class WatchDocumentsArgs { lateinit var channel: Channel }
@InvokeArg class DriveArgs { var interactive: Boolean = false }
@InvokeArg class PruneArgs { var keep: List<String> = emptyList() }

private const val DRIVE_UNAVAILABLE = "Google no pudo autorizar Drive. Comprueba tu conexión y los servicios de Google Play."

@TauriPlugin
class FolioPlugin(private val launch: Activity) : Plugin(launch) {
    // This plugin outlives a recreated activity; dialogs and the window need the current one.
    private val activity: Activity get() = PluginManager.activity ?: launch

    /** System Google authorization owns credentials; no tokens are persisted in JS. */
    private fun driveRequest(interactive: Boolean) = AuthorizationRequest.builder()
        .setRequestedScopes(listOf(Scope("https://www.googleapis.com/auth/drive")))
        // Connecting always offers the account picker, so another account can be chosen.
        .apply { if (interactive) setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT) }.build()
    @Command fun driveAuthorize(invoke: Invoke) {
        val interactive = invoke.parseArgs(DriveArgs::class.java).interactive
        Identity.getAuthorizationClient(activity).authorize(driveRequest(interactive)).addOnSuccessListener { result ->
            when {
                !result.hasResolution() -> renewDriveToken(invoke, result.accessToken)
                !interactive -> invoke.reject("Inicia sesión con Google Drive.")
                else -> try { startIntentSenderForResult(invoke, IntentSenderRequest.Builder(result.pendingIntent!!).build(), "driveAuthorized") }
                    catch (_: Exception) { invoke.reject("No se pudo abrir la autorización de Google.") }
            }
        }.addOnFailureListener { invoke.reject(DRIVE_UNAVAILABLE) }
    }
    /** Play services can return a cached token that expires before Rust renews it.
     * Clearing it makes the next authorization issue a token valid for one hour. */
    private fun renewDriveToken(invoke: Invoke, cached: String?) {
        if (cached.isNullOrBlank()) { invoke.reject("Google no concedió acceso a Drive."); return }
        val client = Identity.getAuthorizationClient(activity)
        client.clearToken(ClearTokenRequest.builder().setToken(cached).build())
            .onSuccessTask { client.authorize(driveRequest(false)) }
            .addOnSuccessListener { result ->
                val token = result.accessToken
                if (result.hasResolution() || token.isNullOrBlank()) invoke.reject("Inicia sesión con Google Drive.")
                else invoke.resolve(JSObject().put("access_token", token).put("expires_in", 3600))
            }.addOnFailureListener { invoke.reject(DRIVE_UNAVAILABLE) }
    }
    @ActivityCallback fun driveAuthorized(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) { invoke.reject("Se canceló la conexión con Google Drive."); return }
        val token = try { Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(result.data).accessToken }
            catch (_: Exception) { invoke.reject("No se pudo completar la autorización de Drive."); return }
        // Its lifetime is unknown; Rust renews it early, and then it is issued anew.
        if (token.isNullOrBlank()) invoke.reject("Google no concedió acceso a Drive.") else invoke.resolve(JSObject().put("access_token", token))
    }
    @Command fun driveDisconnect(invoke: Invoke) {
        // Local disconnect only. Revoking Google's grant would also disconnect
        // the user's other devices. Connecting again shows the account picker.
        invoke.resolve()
    }
    private val io = Executors.newSingleThreadExecutor()
    private val incoming = IncomingDocuments(launch.applicationContext, io)
    private var receivedLaunchIntent = false
    override fun load(webView: WebView) {
        if (!receivedLaunchIntent) { receivedLaunchIntent = true; incoming.receive(activity.intent) }
    }
    override fun onNewIntent(intent: Intent) { incoming.receive(intent) }
    @Command fun watchDocuments(invoke: Invoke) {
        val channel = invoke.parseArgs(WatchDocumentsArgs::class.java).channel
        incoming.listen { channel.send(it) }
        invoke.resolve()
    }
    private fun done(invoke: Invoke, completed: Boolean) { invoke.resolve(JSObject().put("completed", completed)) }
    @Command fun pickDocuments(invoke: Invoke) {
        val args = invoke.parseArgs(PickArgs::class.java)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE); type = "application/pdf"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try { startActivityForResult(invoke, intent, "picked") } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo abrir el selector de archivos.")) }
    }
    @ActivityCallback fun picked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) { invoke.resolve(JSObject().put("paths", JSArray())); return }
        val uris = mutableListOf<Uri>()
        result.data?.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
        if (uris.isEmpty()) result.data?.data?.let { uris.add(it) }
        io.execute {
            try {
                val imported = importDocuments(activity, uris, result.data?.flags ?: 0)
                val paths = JSArray(); imported.files.forEach { paths.put(it.absolutePath) }
                val errors = JSArray(); imported.errors.forEach { errors.put(it) }
                invoke.resolve(JSObject().put("paths", paths).put("errors", errors))
            } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo importar el PDF.")) }
        }
    }
    private fun saveFailed(invoke: Invoke, error: Exception) {
        if (error is OriginalRecovered) incoming.recovered(error.file)
        invoke.reject(userMessage(error, "No se pudo guardar en el original."))
    }
    @Command fun saveOriginal(invoke: Invoke) {
        io.execute {
            try {
                val args = invoke.parseArgs(SaveOriginalArgs::class.java)
                overwriteOriginal(activity, privateFile(activity, args.source), privateFile(activity, args.path))
                done(invoke, true)
            } catch (_: OriginalAccessRequired) {
                activity.runOnUiThread { askForOriginal(invoke) }
            } catch (error: Exception) { saveFailed(invoke, error) }
        }
    }
    private fun askForOriginal(invoke: Invoke) {
        val host = activity
        AlertDialog.Builder(host, if (isDark(host, savedTheme(host))) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
            .setTitle("Permitir guardar en el original")
            .setMessage("Elige otra vez el PDF original para que Folio pueda guardar los cambios en ese archivo.")
            .setNegativeButton("Cancelar") { _, _ -> done(invoke, false) }
            .setOnCancelListener { done(invoke, false) }
            .setPositiveButton("Elegir PDF") { _, _ ->
                try {
                    val args = invoke.parseArgs(SaveOriginalArgs::class.java)
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE); type = "application/pdf"
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                        readOriginal(privateFile(host, args.source))?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it.uri) }
                    }
                    startActivityForResult(invoke, intent, "originalSelected")
                } catch (error: Exception) { invoke.reject(userMessage(error, "No se pudo abrir el selector de archivos.")) }
            }.show()
    }
    @ActivityCallback fun originalSelected(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { done(invoke, false); return }
        io.execute {
            try {
                val args = invoke.parseArgs(SaveOriginalArgs::class.java)
                val source = privateFile(activity, args.source)
                val selected = selectedOriginal(activity, source, uri)
                retainDocumentAccess(activity, uri, result.data?.flags ?: 0)
                overwriteOriginal(activity, source, privateFile(activity, args.path), selected)
                done(invoke, true)
            } catch (_: OriginalAccessRequired) { invoke.reject("La app donde está guardado este PDF no permite modificarlo. Tus cambios siguen en Folio; usa Guardar una copia.") }
            catch (error: Exception) { saveFailed(invoke, error) }
        }
    }
    @Command fun exportFile(invoke: Invoke) {
        try {
            val file = privateFile(activity, invoke.parseArgs(PathArgs::class.java).path)
            val mime = when (file.extension.lowercase()) { "pdf" -> "application/pdf"; "txt" -> "text/plain"; "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; "zip" -> "application/zip"; "png" -> "image/png"; "jpg" -> "image/jpeg"; "json" -> "application/json"; else -> "application/octet-stream" }
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = mime; putExtra(Intent.EXTRA_TITLE, file.name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "exported")
        } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo guardar.")) }
    }
    @ActivityCallback fun exported(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { done(invoke, false); return }
        io.execute { try {
            // The picker also returns a file the user chose to replace. Only an
            // empty document, the one it has just created, is removed on failure.
            val created = runCatching {
                activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { it.moveToFirst() && !it.isNull(0) && it.getLong(0) == 0L }
            }.getOrNull() == true
            val file = try {
                privateFile(activity, invoke.parseArgs(PathArgs::class.java).path).also { file ->
                    activity.contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: throw FolioError("No se pudo guardar en esa ubicación. Elige otra carpeta.")
                }
            } catch (error: Exception) {
                if (created) runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
                throw error
            }
            if (file.extension.equals("pdf", true)) {
                retainDocumentAccess(activity, uri, result.data?.flags ?: 0)
                rememberOriginal(file, uri)
            }
            done(invoke, true)
        } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo guardar en esa ubicación. Elige otra carpeta.")) } }
    }
    @Command fun shareFile(invoke: Invoke) {
        io.execute { try {
            val file = privateFile(activity, invoke.parseArgs(PathArgs::class.java).path)
            val cache = File(activity.cacheDir, "FolioShared").apply { mkdirs() }
            cache.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach { it.listFiles()?.forEach(File::delete); it.delete() }
            val copy = File(File(cache, UUID.randomUUID().toString()).apply { mkdirs() }, file.name)
            file.copyTo(copy)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.folio.files", copy)
            activity.runOnUiThread { try {
                val intent = Intent(Intent.ACTION_SEND).apply { type = "application/pdf"; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri(file.name, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                activity.startActivity(Intent.createChooser(intent, "Compartir PDF")); done(invoke, true)
            } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo compartir.")) } }
        } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo compartir.")) } }
    }
    @Command fun printFile(invoke: Invoke) {
        try {
            val file = privateFile(activity, invoke.parseArgs(PathArgs::class.java).path)
            val manager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
            manager.print(file.name, object : PrintDocumentAdapter() {
                override fun onLayout(old: PrintAttributes?, next: PrintAttributes?, signal: CancellationSignal?, callback: LayoutResultCallback, extras: Bundle?) {
                    if (signal?.isCanceled == true) callback.onLayoutCancelled()
                    else callback.onLayoutFinished(PrintDocumentInfo.Builder(file.name).setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(), true)
                }
                override fun onWrite(pages: Array<out PageRange>?, destination: ParcelFileDescriptor?, signal: CancellationSignal?, callback: WriteResultCallback) {
                    io.execute { try {
                        if (signal?.isCanceled == true) { callback.onWriteCancelled(); return@execute }
                        requireNotNull(destination)
                        FileOutputStream(destination.fileDescriptor).use { out -> file.inputStream().use { it.copyTo(out) } }
                        if (signal?.isCanceled == true) callback.onWriteCancelled() else callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                    } catch (e: Exception) { callback.onWriteFailed(userMessage(e, "No se pudo preparar el PDF para imprimir.")) } }
                }
                override fun onFinish() { done(invoke, true) }
            }, null)
        } catch (e: Exception) { invoke.reject(userMessage(e, "No se pudo imprimir.")) }
    }
    /** Imports run on the same worker, so no copy is pruned while it is written. */
    @Command fun prunePrivateCopies(invoke: Invoke) {
        val keep = invoke.parseArgs(PruneArgs::class.java).keep
        io.execute {
            try { deleteUnusedCopies(launch.applicationContext, keep); invoke.resolve() }
            catch (e: Exception) { invoke.reject(userMessage(e, "No se pudieron borrar las copias locales.")) }
        }
    }
    @Command fun setTheme(invoke: Invoke) {
        val args = invoke.parseArgs(ThemeArgs::class.java)
        val host = activity
        val dark = isDark(host, args.theme)
        // The web passes the colour at the top of the current screen.
        val color = args.background?.let { runCatching { Color.parseColor(it.trim()) }.getOrNull() } ?: readerBackground(dark)
        saveTheme(host, args.theme)
        host.runOnUiThread { applyWindowTheme(host, dark, color); invoke.resolve() }
    }
    @Command fun setReaderChrome(invoke: Invoke) {
        val visible = invoke.parseArgs(ChromeArgs::class.java).visible
        activity.runOnUiThread {
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                if (visible) show(WindowInsetsCompat.Type.systemBars()) else hide(WindowInsetsCompat.Type.systemBars())
            }
            ViewCompat.requestApplyInsets(activity.findViewById(android.R.id.content))
            invoke.resolve()
        }
    }
    /** Keeps the screen on while a document is read; the system restores it otherwise. */
    @Command fun setKeepAwake(invoke: Invoke) {
        val on = invoke.parseArgs(KeepAwakeArgs::class.java).on
        activity.runOnUiThread {
            if (on) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }
    /** System haptics, as native controls give them. */
    @Command fun haptic(invoke: Invoke) {
        val kind = invoke.parseArgs(HapticArgs::class.java).kind
        activity.runOnUiThread {
            val feedback = when (kind) {
                "selection" -> android.view.HapticFeedbackConstants.CLOCK_TICK
                "success" -> if (android.os.Build.VERSION.SDK_INT >= 30) android.view.HapticFeedbackConstants.CONFIRM else android.view.HapticFeedbackConstants.VIRTUAL_KEY
                "medium" -> android.view.HapticFeedbackConstants.LONG_PRESS
                else -> android.view.HapticFeedbackConstants.VIRTUAL_KEY
            }
            activity.window.decorView.performHapticFeedback(feedback)
            invoke.resolve()
        }
    }
    @Command fun getSafeArea(invoke: Invoke) {
        activity.runOnUiThread {
            val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
            val bottom = if (insets == null || insets.isVisible(WindowInsetsCompat.Type.ime())) 0 else insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout()).bottom
            invoke.resolve(JSObject().put("bottom", bottom / activity.resources.displayMetrics.density.toDouble()))
        }
    }
    @Command fun openUrl(invoke: Invoke) {
        try { val uri = Uri.parse(invoke.parseArgs(UrlArgs::class.java).url); require(uri.scheme in listOf("http", "https", "mailto", "tel")); activity.startActivity(Intent(Intent.ACTION_VIEW, uri)); invoke.resolve() }
        catch (e: Exception) { invoke.reject("No hay una aplicación disponible para abrir este enlace.") }
    }
}
