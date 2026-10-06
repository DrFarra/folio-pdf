import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

private struct PickArgs: Decodable { let multiple: Bool? }
private struct PathsArgs: Decodable { let paths: [String] }
private struct FileArgs: Decodable { let path: String; let anchor: [Double]? }
private struct ChromeArgs: Decodable { let visible: Bool }
private struct ThemeArgs: Decodable { let theme: String }
private struct TextArgs: Decodable { let text: String }
private struct URLArgs: Decodable { let url: String }

private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
    let picked: ([URL]) -> Void
    let cancelled: () -> Void
    init(picked: @escaping ([URL]) -> Void, cancelled: @escaping () -> Void) {
        self.picked = picked; self.cancelled = cancelled
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        NSLog("Folio file picker selected %ld documents", urls.count)
        picked(urls)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        NSLog("Folio file picker cancelled")
        cancelled()
    }
    deinit { NSLog("Folio file picker delegate released") }
}

final class FolioPlugin: Plugin {
    private let drive = DriveAuthorization()
    @objc public func driveAuthorize(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(DriveAuthArgs.self)
        DispatchQueue.main.async {
            self.drive.authorize(interactive: args.interactive, window: self.webview?.window) { result in
                switch result {
                case .success(let value):
                    // Only native Rust receives this response; tokens never cross
                    // the application command boundary into the web frontend.
                    invoke.resolve(["access_token": value["access_token"] as? String ?? "", "expires_in": value["expires_in"] as? Int ?? 3000])
                case .failure(let error): invoke.reject(error.localizedDescription)
                }
            }
        }
    }
    @objc public func driveDisconnect(_ invoke: Invoke) { drive.disconnect(); invoke.resolve() }
    private var pickerDelegate: PickerDelegate?
    private var presenting = false
    private weak var webview: WKWebView?
    private let pdf = NativePDFService()

    @objc public override func load(webview: WKWebView) {
        self.webview = webview
        // Scrolling belongs to the PDF viewport; WKWebView must not bounce the
        // entire application or apply a second safe-area inset around our CSS.
        webview.scrollView.bounces = false
        webview.scrollView.contentInsetAdjustmentBehavior = .never
        webview.isOpaque = false
        webview.backgroundColor = .systemBackground
    }

    private func presenter() -> UIViewController? {
        var controller = webview?.window?.rootViewController
        if controller == nil {
            controller = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController
        }
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    private func fail(_ invoke: Invoke, _ error: Error) {
        let native = error as NSError
        NSLog("Folio native operation failed [%@:%ld]", native.domain, native.code)
        invoke.reject(native.localizedDescription)
    }

    @objc public func setTheme(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ThemeArgs.self)
        DispatchQueue.main.async {
            let style: UIUserInterfaceStyle = args.theme == "dark" ? .dark : args.theme == "light" ? .light : .unspecified
            self.webview?.window?.overrideUserInterfaceStyle = style
            self.webview?.window?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
            self.webview?.backgroundColor = .systemBackground
            invoke.resolve()
        }
    }

    /// Immersive reading hides the status bar. tao's root view controller owns
    /// prefersStatusBarHidden; its setter refreshes the status bar appearance.
    @objc public func setReaderChrome(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ChromeArgs.self)
        DispatchQueue.main.async {
            if let controller = self.webview?.window?.rootViewController, controller.responds(to: NSSelectorFromString("setPrefersStatusBarHidden:")) {
                UIView.animate(withDuration: 0.2) { controller.setValue(!args.visible, forKey: "prefersStatusBarHidden") }
            }
            invoke.resolve()
        }
    }

    @objc public func nativeStatus(_ invoke: Invoke) {
        DispatchQueue.main.async {
            invoke.resolve(["platform": "iOS", "uiAvailable": self.presenter() != nil,
                            "fileImport": "UIDocumentPickerViewController", "fileExport": "UIDocumentPickerViewController",
                            "share": "UIActivityViewController", "printAvailable": UIPrintInteractionController.isPrintingAvailable,
                            "systemVersion": UIDevice.current.systemVersion])
        }
    }

    @objc public func copyText(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TextArgs.self)
        DispatchQueue.main.async { UIPasteboard.general.string = args.text; invoke.resolve() }
    }

    @objc public func openExternalUrl(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(URLArgs.self)
        guard let url = URL(string: args.url), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto", "tel"].contains(scheme) else {
            invoke.reject("El enlace no es compatible."); return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { invoke.resolve() } else { invoke.reject("No se pudo abrir este enlace.") }
            }
        }
    }

    private func importURLs(_ urls: [URL]) throws -> [String] {
        let manager = FileManager.default
        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let imports = documents.appendingPathComponent("Imports", isDirectory: true)
        try manager.createDirectory(at: imports, withIntermediateDirectories: true)
        var copies = [String]()
        for url in urls {
            guard url.isFileURL, url.pathExtension.lowercased() == "pdf" else {
                throw NSError(domain: "Folio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Elige un archivo PDF."])
            }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let folder = imports.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent(url.lastPathComponent)
            var coordinatorError: NSError?
            var copyError: Error?
            let resolved = url.standardizedFileURL.resolvingSymlinksInPath().path
            let staging = manager.temporaryDirectory.standardizedFileURL.resolvingSymlinksInPath().path + "/"
            let inbox = documents.appendingPathComponent("Inbox").standardizedFileURL.resolvingSymlinksInPath().path + "/"
            if resolved.hasPrefix(staging) || resolved.hasPrefix(inbox) {
                // These are UIKit's app-owned import copies, never a provider
                // original or an already opened Folio source. A rename avoids
                // keeping two extra gigabytes on the device during import.
                do { try manager.moveItem(at: url, to: destination) } catch { copyError = error }
            } else {
                NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinatorError) { readable in
                    do { try manager.copyItem(at: readable, to: destination) } catch { copyError = error }
                }
            }
            if let error = coordinatorError ?? (copyError as NSError?) {
                try? manager.removeItem(at: folder)
                NSLog("Folio import copy failed [%@:%ld]: %@", error.domain, error.code, error.localizedDescription)
                throw NSError(domain: "Folio.Import", code: error.code, userInfo: [NSLocalizedDescriptionKey: "No se pudo importar «\(url.lastPathComponent)». Vuelve a intentarlo."])
            }
            copies.append(destination.path)
        }
        return copies
    }

    private func localFile(_ path: String) throws -> URL {
        let file = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let sandbox = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(sandbox.path + "/"), FileManager.default.fileExists(atPath: file.path) else {
            throw NSError(domain: "Folio", code: 2, userInfo: [NSLocalizedDescriptionKey: "El archivo no está disponible en Folio."])
        }
        return file
    }

    @objc public func importPaths(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PathsArgs.self)
        DispatchQueue.global(qos: .userInitiated).async {
            do { invoke.resolve(["paths": try self.importURLs(args.paths.map { URL(fileURLWithPath: $0) })]) }
            catch { self.fail(invoke, error) }
        }
    }

    @objc public func pickDocuments(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PickArgs.self)
        DispatchQueue.main.async {
            guard !self.presenting, let parent = self.presenter() else { invoke.reject("Cierra el diálogo abierto antes de elegir otro archivo."); return }
            self.presenting = true
            // UIKit first creates an app-owned copy. The provider authorization
            // must not be reconstructed from a string after its delegate exits.
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.pdf], asCopy: true)
            picker.allowsMultipleSelection = args.multiple ?? true
            if ProcessInfo.processInfo.arguments.contains("--folio-ui-test-picker") {
                picker.directoryURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            }
            self.pickerDelegate = PickerDelegate(picked: { urls in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let paths = try self.importURLs(urls)
                        NSLog("Folio file picker imported %ld documents", paths.count)
                        DispatchQueue.main.async { self.presenting = false; self.pickerDelegate = nil; invoke.resolve(["paths": paths]) }
                    }
                    catch {
                        DispatchQueue.main.async { self.presenting = false; self.pickerDelegate = nil; self.fail(invoke, error) }
                    }
                }
            }, cancelled: {
                self.presenting = false; self.pickerDelegate = nil; invoke.resolve(["paths": [String]()])
            })
            picker.delegate = self.pickerDelegate
            parent.present(picker, animated: true) {
                NSLog("Folio file picker presented; delegate attached: %d", picker.delegate != nil)
            }
        }
    }

    private func pdfOperation(_ invoke: Invoke, _ operation: @escaping () throws -> [String: Any]) {
        pdf.queue.async {
            autoreleasepool {
                do { invoke.resolve(try operation()) }
                catch { self.fail(invoke, error) }
            }
        }
    }
    @objc public func pdfOpen(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFOpenArgs.self); _ = try localFile(args.path)
        pdfOperation(invoke) { try self.pdf.open(args) }
    }
    @objc public func pdfPageInfo(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFPageArgs.self)
        pdfOperation(invoke) { try self.pdf.pageInfo(args.token, args.page) }
    }
    @objc public func pdfRender(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFRenderArgs.self)
        pdfOperation(invoke) { try self.pdf.render(args) }
    }
    @objc public func pdfText(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFPageArgs.self)
        pdfOperation(invoke) { try self.pdf.text(args.token, args.page) }
    }
    @objc public func pdfOutline(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFTokenArgs.self)
        pdfOperation(invoke) { ["entries": try self.pdf.outline(args.token)] }
    }
    @objc public func pdfClose(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFTokenArgs.self)
        pdfOperation(invoke) { self.pdf.close(args.token); return [:] }
    }
    @objc public func pdfPermissions(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFTokenArgs.self)
        pdfOperation(invoke) { try self.pdf.permissions(args.token) }
    }
    @objc public func pdfExport(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PDFExportArgs.self)
        let target = URL(fileURLWithPath: args.path).standardizedFileURL.resolvingSymlinksInPath()
        let sandbox = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath()
        guard target.path.hasPrefix(sandbox.path + "/"), !FileManager.default.fileExists(atPath: target.path) else { invoke.reject("Destino de copia inválido."); return }
        pdfOperation(invoke) { try self.pdf.export(args) }
    }

    @objc public func exportFile(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FileArgs.self)
        let file = try localFile(args.path)
        DispatchQueue.main.async {
            guard !self.presenting, let parent = self.presenter() else { invoke.reject("Cierra el diálogo abierto antes de guardar."); return }
            self.presenting = true
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            self.pickerDelegate = PickerDelegate(picked: { _ in
                self.presenting = false; self.pickerDelegate = nil; invoke.resolve(["completed": true])
            }, cancelled: {
                self.presenting = false; self.pickerDelegate = nil; invoke.resolve(["completed": false])
            })
            picker.delegate = self.pickerDelegate
            parent.present(picker, animated: true)
        }
    }

    /// iPad popovers point at the control that opened them: the frontend sends
    /// its rect as [x, y, width, height] in webview points.
    private func source(_ anchor: [Double]?) -> (view: UIView, rect: CGRect)? {
        guard let view = webview, let a = anchor, a.count == 4, a.allSatisfy({ $0.isFinite }) else { return nil }
        return (view, CGRect(x: a[0], y: a[1], width: a[2], height: a[3]))
    }

    @objc public func shareFile(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FileArgs.self)
        let file = try localFile(args.path)
        DispatchQueue.main.async {
            guard !self.presenting, let parent = self.presenter() else { invoke.reject("Cierra el diálogo abierto antes de compartir."); return }
            self.presenting = true
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, error in
                self.presenting = false
                if let error = error { self.fail(invoke, error) } else { invoke.resolve(["completed": completed]) }
            }
            if let popover = sheet.popoverPresentationController {
                if let source = self.source(args.anchor) { popover.sourceView = source.view; popover.sourceRect = source.rect }
                else {
                    popover.sourceView = parent.view
                    popover.sourceRect = CGRect(x: parent.view.bounds.midX, y: parent.view.bounds.maxY - 24, width: 1, height: 1)
                    popover.permittedArrowDirections = []
                }
            }
            parent.present(sheet, animated: true)
        }
    }

    @objc public func printFile(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FileArgs.self)
        let file = try localFile(args.path)
        DispatchQueue.main.async {
            guard !self.presenting, let parent = self.presenter(), UIPrintInteractionController.isPrintingAvailable,
                  UIPrintInteractionController.canPrint(file) else { invoke.reject("Este PDF no se puede imprimir en este dispositivo."); return }
            self.presenting = true
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = file.lastPathComponent; info.outputType = .general
            controller.printInfo = info; controller.printingItem = file
            let completion: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                self.presenting = false
                if let error = error { self.fail(invoke, error) } else { invoke.resolve(["completed": completed]) }
            }
            let shown: Bool
            if UIDevice.current.userInterfaceIdiom == .pad, let source = self.source(args.anchor) {
                shown = controller.present(from: source.rect, in: source.view, animated: true, completionHandler: completion)
            } else if UIDevice.current.userInterfaceIdiom == .pad {
                shown = controller.present(from: CGRect(x: parent.view.bounds.midX, y: 40, width: 1, height: 1), in: parent.view, animated: true, completionHandler: completion)
            } else { shown = controller.present(animated: true, completionHandler: completion) }
            if !shown { self.presenting = false; invoke.reject("No se pudo abrir el diálogo de impresión.") }
        }
    }
}

@_cdecl("init_plugin_folio_ios")
func initPlugin() -> Plugin { FolioPlugin() }
