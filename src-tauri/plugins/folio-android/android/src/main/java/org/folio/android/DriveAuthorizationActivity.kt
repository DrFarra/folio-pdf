package org.folio.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope

/** System Google authorization owns credentials; no tokens are persisted in JS. */
class DriveAuthorizationActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        val request = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope("https://www.googleapis.com/auth/drive"))).build()
        Identity.getAuthorizationClient(this).authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    if (!intent.getBooleanExtra("interactive", false)) { failed("Inicia sesión con Google Drive."); return@addOnSuccessListener }
                    try { startIntentSenderForResult(result.pendingIntent!!.intentSender, 713, null, 0, 0, 0) }
                    catch (_: Exception) { failed("No se pudo abrir la autorización de Google.") }
                } else completed(result.accessToken)
            }.addOnFailureListener { failed("Google no pudo autorizar Drive. Comprueba tu conexión y Google Play Services.") }
    }
    @Deprecated("Google authorization resolution uses IntentSender")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 713) return
        if (resultCode != RESULT_OK) { failed("Se canceló la conexión con Google Drive."); return }
        try { completed(Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(data).accessToken) }
        catch (_: Exception) { failed("No se pudo completar la autorización de Drive.") }
    }
    private fun completed(token: String?) {
        if (token.isNullOrBlank()) { failed("Google no concedió acceso a Drive."); return }
        setResult(RESULT_OK, Intent().putExtra("access_token", token)); finish()
    }
    private fun failed(message: String) { setResult(RESULT_CANCELED, Intent().putExtra("error", message)); finish() }
}
