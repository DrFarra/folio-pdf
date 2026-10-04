import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

private struct PickArgs: Decodable { let multiple: Bool? }
private struct PathsArgs: Decodable { let paths: [String] }
private struct FileArgs: Decodable { let path: String }
private struct ThemeArgs: Decodable { let theme: String }

private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
    let picked: ([URL]) -> Void
    let cancelled: () -> Void
    init(picked: @escaping ([URL]) -> Void, cancelled: @escaping () -> Void) {
        self.picked = picked; self.cancelled = cancelled
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { picked(urls) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cancelled() }
}

final class FolioPlugin: Plugin {
    private var pickerDelegate: PickerDelegate?
    private var presenting = false
    private weak var webview: WKWebView?

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

    private func fail(_ invoke: Invoke, _ error: Error) { invoke.reject(error.localizedDescription) }

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

    @objc public func nativeStatus(_ invoke: Invoke) {
        DispatchQueue.main.async {
            invoke.resolve(["platform": "iOS", "uiAvailable": self.presenter() != nil,
                            "fileImport": "UIDocumentPickerViewController", "fileExport": "UIDocumentPickerViewController",
                            "share": "UIActivityViewController", "printAvailable": UIPrintInteractionController.isPrintingAvailable,
                            "systemVersion": UIDevice.current.systemVersion])
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
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinatorError) { readable in
                do { try manager.copyItem(at: readable, to: destination) } catch { copyError = error }
            }
            if let error = coordinatorError ?? (copyError as NSError?) { throw error }
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
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.pdf], asCopy: false)
            picker.allowsMultipleSelection = args.multiple ?? true
            self.pickerDelegate = PickerDelegate(picked: { urls in
                self.presenting = false; self.pickerDelegate = nil
                DispatchQueue.global(qos: .userInitiated).async {
                    do { invoke.resolve(["paths": try self.importURLs(urls)]) }
                    catch { self.fail(invoke, error) }
                }
            }, cancelled: {
                self.presenting = false; self.pickerDelegate = nil; invoke.resolve(["paths": [String]()])
            })
            picker.delegate = self.pickerDelegate
            parent.present(picker, animated: true)
        }
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
                popover.sourceView = parent.view
                popover.sourceRect = CGRect(x: parent.view.bounds.midX, y: parent.view.bounds.maxY - 24, width: 1, height: 1)
                popover.permittedArrowDirections = []
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
            if UIDevice.current.userInterfaceIdiom == .pad {
                shown = controller.present(from: CGRect(x: parent.view.bounds.midX, y: 40, width: 1, height: 1), in: parent.view, animated: true, completionHandler: completion)
            } else { shown = controller.present(animated: true, completionHandler: completion) }
            if !shown { self.presenting = false; invoke.reject("No se pudo abrir el diálogo de impresión.") }
        }
    }
}

@_cdecl("init_plugin_folio_ios")
func initPlugin() -> Plugin { FolioPlugin() }
