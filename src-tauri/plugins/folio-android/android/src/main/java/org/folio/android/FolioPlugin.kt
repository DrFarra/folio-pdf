package org.folio.android

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.*
import android.provider.DocumentsContract
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.*
import app.tauri.plugin.*
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg class PickArgs { var multiple: Boolean = true }
@InvokeArg class PathArgs { lateinit var path: String }
@InvokeArg class SaveOriginalArgs { lateinit var path: String; lateinit var source: String }
@InvokeArg class ThemeArgs { var theme: String = "light" }
@InvokeArg class ChromeArgs { var visible: Boolean = true }
@InvokeArg class UrlArgs { lateinit var url: String }
@InvokeArg class WatchDocumentsArgs { lateinit var channel: Channel }
@InvokeArg class DriveArgs { var interactive: Boolean = false }

@TauriPlugin
class FolioPlugin(private val activity: Activity) : Plugin(activity) {
    @Command fun driveAuthorize(invoke: Invoke) {
        val args = invoke.parseArgs(DriveArgs::class.java)
        startActivityForResult(invoke, Intent(activity, DriveAuthorizationActivity::class.java).putExtra("interactive", args.interactive), "driveAuthorized")
    }
    @ActivityCallback fun driveAuthorized(invoke: Invoke, result: ActivityResult) {
        val token = result.data?.getStringExtra("access_token")
        if (result.resultCode == Activity.RESULT_OK && !token.isNullOrBlank()) invoke.resolve(JSObject().put("access_token", token).put("expires_in", 3000))
        else invoke.reject(result.data?.getStringExtra("error") ?: "Se canceló la conexión con Drive.")
    }
    @Command fun driveDisconnect(invoke: Invoke) {
        // Local disconnect only. Revoking Google's grant would also disconnect
        // the user's other devices. Reconnecting explicitly shows Google again.
        invoke.resolve()
    }
    private val io = Executors.newSingleThreadExecutor()
    private val incoming = IncomingDocuments(activity, io)
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
    private fun ownFile(path: String): File {
        val file = File(path).canonicalFile
        require(file.path.startsWith(activity.filesDir.canonicalPath + File.separator)) { "El archivo no pertenece a Folio." }
        require(file.isFile) { "El archivo ya no está disponible." }
        return file
    }
    @Command fun pickDocuments(invoke: Invoke) {
        val args = invoke.parseArgs(PickArgs::class.java)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE); type = "application/pdf"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try { startActivityForResult(invoke, intent, "picked") } catch (e: Exception) { invoke.reject("No se pudo abrir el selector: ${e.message}") }
    }
    @ActivityCallback fun picked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) { invoke.resolve(JSObject().put("paths", JSArray())); return }
        val uris = mutableListOf<Uri>()
        result.data?.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
        if (uris.isEmpty()) result.data?.data?.let { uris.add(it) }
        io.execute {
            try {
                val copied = importDocuments(activity, uris, result.data?.flags ?: 0)
                val paths = JSArray(); copied.forEach { paths.put(it.absolutePath) }; invoke.resolve(JSObject().put("paths", paths))
            } catch (e: Exception) { invoke.reject(e.message ?: "No se pudo importar el PDF.") }
        }
    }
    @Command fun saveOriginal(invoke: Invoke) {
        io.execute {
            try {
                val args = invoke.parseArgs(SaveOriginalArgs::class.java)
                overwriteOriginal(activity, ownFile(args.source), ownFile(args.path))
                done(invoke, true)
            } catch (_: OriginalAccessRequired) {
                activity.runOnUiThread {
                    AlertDialog.Builder(activity).setTitle("Guardar en el original")
                        .setMessage("Selecciona el PDF original para permitir que Folio guarde los cambios en ese mismo archivo. Solo hace falta mientras no tenga permiso de escritura.")
                        .setNegativeButton("Cancelar") { _, _ -> done(invoke, false) }
                        .setOnCancelListener { done(invoke, false) }
                        .setPositiveButton("Seleccionar original") { _, _ ->
                            try {
                                val args = invoke.parseArgs(SaveOriginalArgs::class.java)
                                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                    addCategory(Intent.CATEGORY_OPENABLE); type = "application/pdf"
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                                    readOriginal(ownFile(args.source))?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it.uri) }
                                }
                                startActivityForResult(invoke, intent, "originalSelected")
                            } catch (error: Exception) { invoke.reject(error.message ?: "No se pudo elegir el original.") }
                        }.show()
                }
            } catch (error: Exception) { invoke.reject(error.message ?: "No se pudo guardar en el original.") }
        }
    }
    @ActivityCallback fun originalSelected(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { done(invoke, false); return }
        io.execute {
            try {
                val args = invoke.parseArgs(SaveOriginalArgs::class.java)
                val source = ownFile(args.source)
                val selected = selectedOriginal(activity, source, uri)
                retainDocumentAccess(activity, uri, result.data?.flags ?: 0)
                overwriteOriginal(activity, source, ownFile(args.path), selected)
                done(invoke, true)
            } catch (_: OriginalAccessRequired) { invoke.reject("Este proveedor no permite modificar el PDF. Tus cambios siguen en Folio; usa Guardar una copia.") }
            catch (error: Exception) { invoke.reject(error.message ?: "No se pudo guardar en el original.") }
        }
    }
    @Command fun exportFile(invoke: Invoke) {
        try {
            val file = ownFile(invoke.parseArgs(PathArgs::class.java).path)
            val mime = when (file.extension.lowercase()) { "pdf" -> "application/pdf"; "txt" -> "text/plain"; "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; "zip" -> "application/zip"; "png" -> "image/png"; "jpg" -> "image/jpeg"; "json" -> "application/json"; else -> "application/octet-stream" }
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = mime; putExtra(Intent.EXTRA_TITLE, file.name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "exported")
        } catch (e: Exception) { invoke.reject(e.message ?: "No se pudo guardar.") }
    }
    @ActivityCallback fun exported(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { done(invoke, false); return }
        io.execute { try {
            val file = ownFile(invoke.parseArgs(PathArgs::class.java).path)
            activity.contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("No se pudo escribir en el destino.")
            if (file.extension.equals("pdf", true)) {
                retainDocumentAccess(activity, uri, result.data?.flags ?: 0)
                rememberOriginal(file, uri)
            }
            done(invoke, true)
        } catch (e: Exception) { invoke.reject(e.message ?: "No se pudo guardar.") } }
    }
    @Command fun shareFile(invoke: Invoke) {
        io.execute { try {
            val file = ownFile(invoke.parseArgs(PathArgs::class.java).path)
            val cache = File(activity.cacheDir, "FolioShared").apply { mkdirs() }
            cache.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach { it.listFiles()?.forEach(File::delete); it.delete() }
            val copy = File(File(cache, UUID.randomUUID().toString()).apply { mkdirs() }, file.name)
            file.copyTo(copy)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.folio.files", copy)
            activity.runOnUiThread { try {
                val intent = Intent(Intent.ACTION_SEND).apply { type = "application/pdf"; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri(file.name, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                activity.startActivity(Intent.createChooser(intent, "Compartir PDF")); done(invoke, true)
            } catch (e: Exception) { invoke.reject(e.message ?: "No se pudo compartir.") } }
        } catch (e: Exception) { invoke.reject(e.message ?: "No se pudo compartir.") } }
    }
    @Command fun printFile(invoke: Invoke) {
        try {
            val file = ownFile(invoke.parseArgs(PathArgs::class.java).path)
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
                    } catch (e: Exception) { callback.onWriteFailed(e.message) } }
                }
                override fun onFinish() { done(invoke, true) }
            }, null)
        } catch (e: Exception) { invoke.reject(e.message ?: "No se pudo imprimir.") }
    }
    @Command fun setTheme(invoke: Invoke) {
        val dark = invoke.parseArgs(ThemeArgs::class.java).theme == "dark"
        activity.runOnUiThread {
            activity.findViewById<android.view.View>(android.R.id.content).setBackgroundColor(if (dark) Color.rgb(42,46,59) else Color.WHITE)
            activity.window.statusBarColor = Color.TRANSPARENT
            activity.window.navigationBarColor = Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= 29) {
                activity.window.isStatusBarContrastEnforced = false
                activity.window.isNavigationBarContrastEnforced = false
            }
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark }
            invoke.resolve()
        }
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
