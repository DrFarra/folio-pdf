import Foundation
import PDFKit
import UIKit
import CoreGraphics

struct PDFOpenArgs: Decodable { let token: String; let path: String; let id: String; let revision: String; let size: UInt64; let password: String? }
struct PDFPageArgs: Decodable { let token: String; let page: Int }
struct PDFTokenArgs: Decodable { let token: String }
struct PDFRenderArgs: Decodable { let token: String; let page: Int; let width: Int; let height: Int; let rotation: Int }
struct PDFOverlay: Decodable {
    let id: String; let page: Int; let kind: String; let rect: [Double]; let color: String; let text: String
    let created: Double; let author: String?; let opacity: Double?; let nativeSourceRef: String?; let originalName: String?; let quads: [[Double]]?
}
struct PDFExportArgs: Decodable { let token: String; let path: String; let annotations: [PDFOverlay]; let removedSourceRefs: [String] }

/// The PDF stays in the app sandbox. PDFKit owns the file-backed parser, while
/// page-sized text/rasters are the only reader payloads crossing the bridge.
/// All PDFKit access, including temporary annotation visibility, is serialized.
final class NativePDFService {
    let queue = DispatchQueue(label: "org.folio.pdf.file-reader", qos: .userInitiated)
    private final class Entry {
        let args: PDFOpenArgs
        let document: PDFDocument
        let signed: Bool
        var used = Date()
        init(_ args: PDFOpenArgs, _ document: PDFDocument, _ signed: Bool) { self.args = args; self.document = document; self.signed = signed }
        // PDFKit declares PDFAccessPermissions as an enum carrying a bit mask,
        // rather than a Swift OptionSet (including on the iOS 18 SDK).
        var canAnnotate: Bool { !signed && !document.isLocked && (!document.isEncrypted || (document.accessPermissions.rawValue & PDFAccessPermissions.allowsCommenting.rawValue) != 0) }
    }
    private var entries = [String: Entry]()
    private var opened = [String: PDFOpenArgs]()
    private func boundCache(_ active: String) {
        if entries.count > 4, let oldest = entries.filter({ $0.key != active }).min(by: { $0.value.used < $1.value.used }) { entries.removeValue(forKey: oldest.key) }
    }

    private func error(_ message: String) -> NSError { NSError(domain: "Folio.PDFKit", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func entry(_ token: String) throws -> Entry {
        if entries[token] == nil, let args = opened[token] {
            guard let document = PDFDocument(url: URL(fileURLWithPath: args.path)) else { throw error("No se pudo volver a abrir el PDF.") }
            if document.isLocked { _ = document.unlock(withPassword: args.password ?? "") }
            entries[token] = Entry(args, document, signed(URL(fileURLWithPath: args.path))); boundCache(token)
        }
        guard let value = entries[token] else { throw error("El lector nativo ya cerró este PDF. Vuelve a abrirlo.") }
        guard !value.document.isLocked else { throw error("Este PDF necesita una contraseña.") }
        value.used = Date(); return value
    }
    private func page(_ entry: Entry, _ number: Int) throws -> PDFPage {
        guard number > 0, number <= entry.document.pageCount, let page = entry.document.page(at: number - 1) else { throw error("La página solicitada no existe.") }
        return page
    }
    private func bounds(_ rect: CGRect) -> [Double] { [Double(rect.minX), Double(rect.minY), Double(rect.maxX), Double(rect.maxY)] }
    private func signed(_ url: URL) -> Bool {
        guard let cg = CGPDFDocument(url as CFURL), let catalog = cg.catalog else { return false }
        var form: CGPDFDictionaryRef?
        if CGPDFDictionaryGetDictionary(catalog, "AcroForm", &form), let form = form {
            var flags: CGPDFInteger = 0
            if CGPDFDictionaryGetInteger(form, "SigFlags", &flags), flags & 1 != 0 { return true }
        }
        var perms: CGPDFDictionaryRef?, signature: CGPDFDictionaryRef?
        return CGPDFDictionaryGetDictionary(catalog, "Perms", &perms) && perms != nil && CGPDFDictionaryGetDictionary(perms!, "DocMDP", &signature)
    }
    func open(_ args: PDFOpenArgs) throws -> [String: Any] {
        guard let document = PDFDocument(url: URL(fileURLWithPath: args.path)) else { throw error("PDFKit no pudo abrir el archivo. Comprueba que sea un PDF válido.") }
        if document.isLocked, let password = args.password, !password.isEmpty { _ = document.unlock(withPassword: password) }
        let value = Entry(args, document, signed(URL(fileURLWithPath: args.path)))
        opened[args.token] = args
        entries[args.token] = value
        // Tabs can stay open without retaining an unlimited number of parsers.
        // Entries beyond this bound are closed; the adapter must reopen them.
        boundCache(args.token)
        var result: [String: Any] = ["id": args.id, "revision": args.revision, "size": args.size, "locked": document.isLocked,
            "numPages": document.isLocked ? 0 : document.pageCount, "signed": value.signed,
            "accessPermissionsRaw": document.accessPermissions.rawValue,
            "permissions": ["canCopy": !document.isLocked && document.allowsCopying, "canPrint": !document.isLocked && document.allowsPrinting,
                "canAnnotate": value.canAnnotate, "canEdit": false, "canAssemble": false, "canFill": false]]
        if !document.isLocked && document.pageCount > 0 { var first = try pageInfo(args.token, 1); first["page"] = 1; result["firstPage"] = first }
        return result
    }
    private func overlayKind(_ annotation: PDFAnnotation) -> String? {
        let type = annotation.type?.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        if type == "highlight" { return "highlight" }
        if type == "text" { return "note" }
        return nil
    }
    private func overlayRect(_ annotation: PDFAnnotation) -> [Double] {
        if overlayKind(annotation) == "note" { let p = annotation.bounds; return [Double(p.minX), Double(p.maxY), Double(p.minX), Double(p.maxY)] }
        return bounds(annotation.bounds)
    }
    private func colorHex(_ color: UIColor) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
        if !color.getRed(&r, green: &g, blue: &b, alpha: &a) { return "#f5d76e" }
        return String(format: "#%02x%02x%02x", Int((min(1, max(0, r)) * 255).rounded()), Int((min(1, max(0, g)) * 255).rounded()), Int((min(1, max(0, b)) * 255).rounded()))
    }
    private func opacity(_ annotation: PDFAnnotation) -> Double {
        let value = (annotation.value(forAnnotationKey: PDFAnnotationKey(rawValue: "CA")) ?? annotation.value(forAnnotationKey: PDFAnnotationKey(rawValue: "/CA"))) as? NSNumber
        return min(1, max(0, value?.doubleValue ?? Double(annotation.color.cgColor.alpha)))
    }
    private var opacityKey: PDFAnnotationKey {
        PDFAnnotationKey(rawValue: (PDFAnnotationKey.name.rawValue.hasPrefix("/") ? "/" : "") + "CA")
    }
    private func sourceOpacity(_ page: PDFPage, _ index: Int) -> Double {
        guard let reference = page.pageRef, let source = reference.dictionary else { return opacity(page.annotations[index]) }
        var array: CGPDFArrayRef?, dictionary: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetArray(source, "Annots", &array), let array = array else { return opacity(page.annotations[index]) }
        if let name = page.annotations[index].value(forAnnotationKey: .name) as? String, !name.isEmpty {
            // PDFKit can omit unsupported annotations from its public array.
            // Prefer the source /NM identity before using the original index.
            for candidate in 0..<CGPDFArrayGetCount(array) {
                var item: CGPDFDictionaryRef?, pdfName: CGPDFStringRef?
                if CGPDFArrayGetDictionary(array, candidate, &item), let item = item,
                   CGPDFDictionaryGetString(item, "NM", &pdfName), let pdfName = pdfName,
                   let actual = CGPDFStringCopyTextString(pdfName), actual as String == name { dictionary = item; break }
            }
        }
        if dictionary == nil && index < CGPDFArrayGetCount(array) { _ = CGPDFArrayGetDictionary(array, index, &dictionary) }
        guard let dictionary = dictionary else { return opacity(page.annotations[index]) }
        // /CA is not exposed by PDFKit's annotationKeyValues on the iOS SDK.
        // Read the immutable PDF annotation dictionary without materializing
        // the document or changing an annotation's appearance/geometry.
        var alpha: CGPDFReal = 1
        if CGPDFDictionaryGetNumber(dictionary, "CA", &alpha) { return min(1, max(0, Double(alpha))) }
        return 1
    }
    private func annotationQuads(_ annotation: PDFAnnotation) -> [[Double]] {
        guard let points = annotation.quadrilateralPoints, points.count >= 4 else { return [] }
        return stride(from: 0, to: points.count - 3, by: 4).map { start in
            points[start..<start+4].flatMap { point -> [Double] in let p = point.cgPointValue; return [Double(p.x + annotation.bounds.minX), Double(p.y + annotation.bounds.minY)] }
        }
    }
    private func matches(_ overlay: PDFOverlay, _ annotation: PDFAnnotation, _ alpha: Double) -> Bool {
        guard overlay.kind == overlayKind(annotation), overlay.text == (annotation.contents ?? ""),
              (overlay.author ?? "") == (annotation.userName ?? ""),
              overlay.color.lowercased() == colorHex(annotation.color).lowercased(), overlay.rect.count == 4,
              abs((overlay.opacity ?? alpha) - alpha) < 0.001 else { return false }
        if zip(overlay.rect, overlayRect(annotation)).contains(where: { abs($0.0 - $0.1) > 0.01 }) { return false }
        let existing = annotationQuads(annotation), requested = overlay.quads ?? []
        if existing.count != requested.count { return false }
        for (a, b) in zip(existing, requested) { if a.count != b.count || zip(a,b).contains(where: { abs($0.0 - $0.1) > 0.01 }) { return false } }
        return true
    }
    func pageInfo(_ token: String, _ number: Int) throws -> [String: Any] {
        let value = try entry(token), page = try page(value, number)
        var annotations = [[String: Any]]()
        if value.canAnnotate {
            for (index, annotation) in page.annotations.enumerated() {
                guard let kind = overlayKind(annotation), annotation.shouldDisplay else { continue }
                let reference = "pdfkit:\(number):\(index)"
                var item: [String: Any] = ["id": reference, "nativeSourceRef": reference, "page": number, "kind": kind,
                    "rect": overlayRect(annotation), "color": colorHex(annotation.color), "text": annotation.contents ?? "",
                    "created": (annotation.modificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                    "author": annotation.userName ?? "", "opacity": sourceOpacity(page, index)]
                if let name = annotation.value(forAnnotationKey: .name) as? String { item["originalName"] = name }
                let quads = annotationQuads(annotation); if !quads.isEmpty { item["quads"] = quads }
                annotations.append(item)
            }
        }
        return ["view": bounds(page.bounds(for: .cropBox)), "rotation": ((page.rotation % 360) + 360) % 360, "annotations": annotations,
                "sourceAnnotationTypes": page.annotations.map { ($0.type ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) }]
    }
    func render(_ args: PDFRenderArgs) throws -> [String: Any] {
        guard args.width > 0, args.height > 0, args.width <= 4096, args.height <= 4096,
              Int64(args.width) * Int64(args.height) <= 4_000_000, [0, 90, 180, 270].contains(args.rotation) else { throw error("El tamaño o la rotación del renderizado no son válidos.") }
        let value = try entry(args.token), page = try page(value, args.page)
        guard let cgPage = page.pageRef else { throw error("No se pudo leer la imagen de esta página.") }
        let space = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil, width: args.width, height: args.height, bitsPerComponent: 8, bytesPerRow: args.width * 4,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw error("No hay memoria disponible para dibujar esta página.") }
        let target = CGRect(x: 0, y: 0, width: args.width, height: args.height)
        context.setFillColor(UIColor.white.cgColor); context.fill(target)
        context.concatenate(cgPage.getDrawingTransform(.cropBox, rect: target, rotate: Int32(args.rotation - page.rotation), preserveAspectRatio: true))
        context.drawPDFPage(cgPage)
        // PDFPage's base CGPDFPage excludes annotations. Draw exactly those that
        // are not represented by editable HTML overlays, preserving widgets,
        // links, stamps and read-only/signed annotation appearances.
        for annotation in page.annotations where annotation.shouldDisplay {
            if value.canAnnotate && overlayKind(annotation) != nil { continue }
            annotation.draw(with: .cropBox, in: context)
        }
        guard let cgImage = context.makeImage(), let png = UIImage(cgImage: cgImage).pngData() else { throw error("No se pudo generar la vista de la página.") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("FolioPageRasters", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let path = folder.appendingPathComponent(UUID().uuidString + ".png")
        try png.write(to: path, options: .atomic)
        return ["path": path.path]
    }
    func text(_ token: String, _ number: Int) throws -> [String: Any] {
        let value = try entry(token)
        guard value.document.allowsCopying else { return ["lines": [[String: Any]]()] }
        let page = try page(value, number), text = (page.string ?? "") as NSString
        var lines = [[String: Any]]()
        // Real selection bounds per word keep the web selection layer aligned
        // even when the PDF's embedded font is unavailable to HTML.
        let regex = try NSRegularExpression(pattern: "\\S+[\\t ]*|[\\r\\n]+")
        for match in regex.matches(in: text as String, range: NSRange(location: 0, length: text.length)) {
            let word = text.substring(with: match.range)
            if word.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if !lines.isEmpty { lines[lines.count - 1]["hasEOL"] = true }; continue
            }
            guard let selection = page.selection(for: match.range) else { continue }
            let box = selection.bounds(for: page)
            guard !box.isNull, box.width > 0, box.height > 0 else { continue }
            lines.append(["text": word, "bounds": bounds(box), "hasEOL": false, "direction": "ltr"])
        }
        if !lines.isEmpty { lines[lines.count - 1]["hasEOL"] = true }
        return ["lines": lines]
    }
    func outline(_ token: String) throws -> [[String: Any]] {
        let value = try entry(token)
        guard let root = value.document.outlineRoot else { return [] }
        var result = [[String: Any]]()
        func visit(_ item: PDFOutline, _ depth: Int) {
            if result.count >= 20_000 || depth > 64 { return }
            if let destination = item.destination, let page = destination.page {
                let index = value.document.index(for: page)
                if index != NSNotFound { result.append(["title": item.label ?? "", "page": index + 1, "depth": depth]) }
            }
            for index in 0..<item.numberOfChildren { if let child = item.child(at: index) { visit(child, depth + 1) } }
        }
        for index in 0..<root.numberOfChildren { if let child = root.child(at: index) { visit(child, 0) } }
        return result
    }
    func close(_ token: String) { entries.removeValue(forKey: token); opened.removeValue(forKey: token) }
    func permissions(_ token: String) throws -> [String: Any] { let value = try entry(token); return ["canPrint": value.document.allowsPrinting] }
    private func color(_ hex: String, _ alpha: Double) -> UIColor {
        let clean = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let rgb = UInt32(clean, radix: 16) ?? 0xf5d76e
        return UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: CGFloat(alpha))
    }
    func export(_ args: PDFExportArgs) throws -> [String: Any] {
        let value = try entry(args.token), target = URL(fileURLWithPath: args.path)
        guard target.standardizedFileURL != URL(fileURLWithPath: value.args.path).standardizedFileURL else { throw error("El original debe conservarse. Elige una copia.") }
        let changed = !args.annotations.isEmpty || !args.removedSourceRefs.isEmpty
        if !changed { try FileManager.default.copyItem(at: URL(fileURLWithPath: value.args.path), to: target); return ["path": target.path] }
        guard value.canAnnotate else { throw error("Este documento no permite modificar anotaciones.") }
        guard let document = PDFDocument(url: URL(fileURLWithPath: value.args.path)) else { throw error("No se pudo preparar la copia del PDF.") }
        if document.isLocked { _ = document.unlock(withPassword: value.args.password ?? "") }
        guard !document.isLocked else { throw error("No se pudo desbloquear la copia del PDF.") }
        // Preserve transparency omitted by PDFKit's public getter. Export can
        // traverse pages lazily; opening/reading still never scans all pages.
        for number in 0..<document.pageCount {
            guard let page = document.page(at: number) else { continue }
            for (index, annotation) in page.annotations.enumerated() {
                let alpha = sourceOpacity(page, index)
                if alpha < 1 {
                    guard annotation.setValue(NSNumber(value: alpha), forAnnotationKey: opacityKey) else { throw error("PDFKit no permitió conservar la transparencia original de una anotación.") }
                }
            }
        }
        // Resolve all source indices before removal. Other pages and annotation
        // types are left intact; never clear the annotation collection wholesale.
        var unchanged = Set<String>()
        for overlay in args.annotations {
            guard let reference = overlay.nativeSourceRef else { continue }
            let parts = reference.split(separator: ":")
            if parts.count == 3, parts[0] == "pdfkit", let number = Int(parts[1]), let index = Int(parts[2]), number > 0,
               let page = document.page(at: number - 1), index >= 0, index < page.annotations.count, matches(overlay, page.annotations[index], sourceOpacity(page, index)) {
                unchanged.insert(reference)
            }
        }
        let replaced = Set(args.removedSourceRefs + args.annotations.compactMap { $0.nativeSourceRef }.filter { !unchanged.contains($0) })
        var removals = [(PDFPage, PDFAnnotation)]()
        for reference in replaced {
            let parts = reference.split(separator: ":")
            guard parts.count == 3, parts[0] == "pdfkit", let number = Int(parts[1]), let index = Int(parts[2]), number > 0,
                  let page = document.page(at: number - 1), index >= 0, index < page.annotations.count else { throw error("Una anotación de origen ya no coincide con el PDF.") }
            let annotation = page.annotations[index]
            guard overlayKind(annotation) != nil else { throw error("Esta anotación de origen no se puede editar en Folio.") }
            removals.append((page, annotation))
        }
        for (page, annotation) in removals { page.removeAnnotation(annotation) }
        for overlay in args.annotations {
            if let reference = overlay.nativeSourceRef, unchanged.contains(reference), !args.removedSourceRefs.contains(reference) { continue }
            guard ["highlight", "note"].contains(overlay.kind), overlay.rect.count == 4, overlay.rect.allSatisfy({ $0.isFinite }),
                  overlay.page > 0, let page = document.page(at: overlay.page - 1) else { throw error("La anotación no tiene una página o posición válida.") }
            var rect = CGRect(x: overlay.rect[0], y: overlay.rect[1], width: overlay.rect[2] - overlay.rect[0], height: overlay.rect[3] - overlay.rect[1])
            if overlay.kind == "note" { rect = CGRect(x: overlay.rect[0], y: overlay.rect[1] - 20, width: 20, height: 20) }
            guard rect.width > 0, rect.height > 0 else { throw error("La anotación tiene un tamaño inválido.") }
            let annotation = PDFAnnotation(bounds: rect, forType: overlay.kind == "highlight" ? .highlight : .text, withProperties: nil)
            let alpha = min(1, max(0, overlay.opacity ?? (overlay.kind == "highlight" ? 0.35 : 1)))
            annotation.color = color(overlay.color, alpha)
            annotation.contents = overlay.text; annotation.userName = overlay.author ?? "Folio"
            annotation.modificationDate = Date(timeIntervalSince1970: overlay.created / 1000)
            _ = annotation.setValue(overlay.originalName ?? overlay.id, forAnnotationKey: .name)
            guard annotation.setValue(NSNumber(value: alpha), forAnnotationKey: opacityKey) else { throw error("PDFKit no permitió guardar la transparencia de la anotación.") }
            if overlay.kind == "highlight", let quads = overlay.quads {
                guard quads.allSatisfy({ $0.count == 8 && $0.allSatisfy({ $0.isFinite }) }) else { throw error("El resaltado contiene coordenadas inválidas.") }
                annotation.quadrilateralPoints = quads.flatMap { quad in stride(from: 0, to: 8, by: 2).map { index in
                    NSValue(cgPoint: CGPoint(x: quad[index] - Double(rect.minX), y: quad[index + 1] - Double(rect.minY)))
                } }
            }
            page.addAnnotation(annotation)
        }
        guard document.write(to: target) else { throw error("No se pudo escribir la copia. Comprueba el espacio disponible.") }
        return ["path": target.path]
    }
}
