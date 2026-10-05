import AuthenticationServices
import CryptoKit
import Security
import UIKit

struct DriveAuthArgs: Decodable { let interactive: Bool }

final class DriveAuthorization: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let client = "743680809956-ttrgvo90qjhd297aauk3p4uvohv6djhi.apps.googleusercontent.com"
    private let scheme = "com.googleusercontent.apps.743680809956-ttrgvo90qjhd297aauk3p4uvohv6djhi"
    private let service = "org.folio.pdf.google-drive"
    private var session: ASWebAuthenticationSession?
    private var anchor: ASPresentationAnchor?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor ?? ASPresentationAnchor() }
    private func query() -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "refresh-token"] }
    func disconnect() { SecItemDelete(query() as CFDictionary) }
    private func refreshToken() -> String? {
        var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    private func store(_ token: String) -> Bool {
        let value = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as [String: Any]
        let status = SecItemUpdate(query() as CFDictionary, value as CFDictionary)
        if status == errSecSuccess { return true }
        if status != errSecItemNotFound { return false }
        return SecItemAdd(query().merging(value) { _, new in new } as CFDictionary, nil) == errSecSuccess
    }
    private func random() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return UUID().uuidString + UUID().uuidString }
        return base64(Data(bytes))
    }
    private func base64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    private func exchange(_ fields: [String: String], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"; request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        request.httpBody = fields.map { $0.key + "=" + ($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") }.joined(separator: "&").data(using: .utf8)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard let response = response as? HTTPURLResponse, response.statusCode == 200, let data = data,
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["access_token"] is String else {
                completion(.failure(self.error("La sesión de Google venció o no hay conexión. Vuelve a conectar Drive."))); return
            }
            if let refresh = value["refresh_token"] as? String, !self.store(refresh) { completion(.failure(self.error("No se pudo guardar la sesión en el llavero."))); return }
            completion(.success(value))
        }.resume()
    }
    private func error(_ message: String) -> NSError { NSError(domain: "FolioDrive", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    func authorize(interactive: Bool, window: UIWindow?, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        if !interactive {
            guard let refresh = refreshToken() else { completion(.failure(error("Inicia sesión con Google Drive."))); return }
            exchange(["client_id": client, "grant_type": "refresh_token", "refresh_token": refresh], completion: completion); return
        }
        guard session == nil else { completion(.failure(error("Ya hay una autorización de Google abierta."))); return }
        anchor = window
        let verifier = random(), state = random(), redirect = scheme + ":/oauthredirect"
        var url = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        url.queryItems = ["client_id": client, "redirect_uri": redirect, "response_type": "code", "scope": "https://www.googleapis.com/auth/drive", "access_type": "offline", "prompt": "consent select_account", "state": state, "code_challenge": base64(Data(SHA256.hash(data: Data(verifier.utf8)))), "code_challenge_method": "S256"].map { URLQueryItem(name: $0.key, value: $0.value) }
        session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: scheme) { callback, _ in
            self.session = nil
            guard let callback = callback, callback.scheme == self.scheme,
                  let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
                  parts.first(where: { $0.name == "state" })?.value == state,
                  let code = parts.first(where: { $0.name == "code" })?.value else { completion(.failure(self.error("Se canceló la autorización de Google."))); return }
            self.exchange(["client_id": self.client, "redirect_uri": redirect, "grant_type": "authorization_code", "code": code, "code_verifier": verifier], completion: completion)
        }
        session?.presentationContextProvider = self
        if session?.start() != true { session = nil; completion(.failure(error("No se pudo abrir la autorización de Google."))) }
    }
}
