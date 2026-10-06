import Foundation
import PDFKit
import UIKit
import CoreGraphics
import FolioMuPDF

struct PDFOpenArgs: Decodable { let token: String; let path: String; let id: String; let revision: String; let size: UInt64; let password: String? }
struct PDFPageArgs: Decodable { let token: String; let page: Int }
struct PDFTokenArgs: Decodable { let token: String }
struct PDFRenderArgs: Decodable { let token: String; let page: Int; let width: Int; let height: Int; let rotation: Int }
struct PDFOverlay: Decodable {
    let id: String; let page: Int; let kind: String; let rect: [Double]; let color: String; let text: String
    let created: Double; let author: String?; let opacity: Double?; let nativeSourceRef: String?; let originalName: String?; let quads: [[Double]]?
    let inkPaths: [[Double]]?; let strokeWidth: Double?
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
        var annotations = [Int: [[String: Any]]]()
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
        guard let value = entries[token] else { throw error("El documento se cerró. Vuelve a abrirlo.") }
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
        guard let document = PDFDocument(url: URL(fileURLWithPath: args.path)) else { throw error("No se pudo abrir este PDF. Puede estar dañado.") }
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
        if type == "ink" { return "ink" }
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
    private func floats<T>(_ value: T, _ count: Int) -> [Double] {
        withUnsafeBytes(of: value) { Array($0.bindMemory(to: Float.self).prefix(count)).map(Double.init) }
    }
    private func sourceAnnotations(_ value: Entry, _ number: Int) throws -> [[String: Any]] {
        if let cached = value.annotations[number] { return cached }
        var pointer: UnsafeMutablePointer<FolioSourceAnnotation>?, count = 0
        var message = [CChar](repeating: 0, count: 2048)
        let messageCapacity = message.count
        let status = value.args.path.withCString { path in
            (value.args.password ?? "").withCString { password in
                folio_pdf_read_annotations(path, password, Int32(number), &pointer, &count, &message, messageCapacity)
            }
        }
        guard status == 0 else {
            NSLog("Folio annotation read failed: %@", String(cString: message))
            throw error("No se pudieron leer las anotaciones de esta página.")
        }
        defer { folio_pdf_free_annotations(pointer, count) }
        var result = [[String: Any]]()
        if let pointer = pointer {
            for index in 0..<count {
                let item = pointer[index]
                if item.flags & (1 | 2 | 32) != 0 { continue }
                let kind = item.kind == 1 ? "highlight" : item.kind == 3 ? "ink" : "note", raw = floats(item.rect, 4), rgb = floats(item.color, 3)
                let rect = kind == "note" ? [raw[0], raw[3], raw[0], raw[3]] : raw
                let reference = "pdfkit:\(number):\(item.index)"
                var dto: [String: Any] = ["id": reference, "nativeSourceRef": reference, "page": number, "kind": kind,
                    "rect": rect, "rawRect": raw,
                    "color": String(format: "#%02x%02x%02x", Int((min(1, max(0, rgb[0])) * 255).rounded()), Int((min(1, max(0, rgb[1])) * 255).rounded()), Int((min(1, max(0, rgb[2])) * 255).rounded())),
                    "text": item.contents.map { String(cString: $0) } ?? "", "author": item.author.map { String(cString: $0) } ?? "",
                    "created": Double(item.modified_seconds) * 1000, "opacity": Double(item.opacity)]
                if let name = item.name, name.pointee != 0 { dto["originalName"] = String(cString: name) }
                if let quads = item.quads, item.quad_count > 0 {
                    dto["quads"] = (0..<item.quad_count).map { number in (0..<8).map { Double(quads[number * 8 + $0]) } }
                }
                if item.kind == 3, let sizes = item.path_sizes, let points = item.ink_points {
                    var offset = 0, paths = [[Double]]()
                    for number in 0..<item.path_count {
                        let count = Int(sizes[number])
                        paths.append((0..<count).map { Double(points[offset + $0]) }); offset += count
                    }
                    dto["inkPaths"] = paths; dto["strokeWidth"] = Double(item.stroke_width)
                }
                result.append(dto)
            }
        }
        if value.annotations.count >= 12, let oldest = value.annotations.keys.sorted().first { value.annotations.removeValue(forKey: oldest) }
        value.annotations[number] = result
        return result
    }
    private func matches(_ overlay: PDFOverlay, _ source: [String: Any]) -> Bool {
        guard overlay.kind == source["kind"] as? String, overlay.text == source["text"] as? String,
              (overlay.author ?? "") == source["author"] as? String,
              overlay.color.lowercased() == (source["color"] as? String)?.lowercased(),
              let rect = source["rect"] as? [Double], rect.count == overlay.rect.count,
              let alpha = source["opacity"] as? Double, abs((overlay.opacity ?? alpha) - alpha) < 0.001 else { return false }
        if zip(overlay.rect, rect).contains(where: { abs($0.0 - $0.1) > 0.01 }) { return false }
        let existing = source["quads"] as? [[Double]] ?? [], requested = overlay.quads ?? []
        if existing.count != requested.count { return false }
        for (a, b) in zip(existing, requested) { if a.count != b.count || zip(a,b).contains(where: { abs($0.0 - $0.1) > 0.01 }) { return false } }
        if overlay.kind == "ink" {
            guard let width = source["strokeWidth"] as? Double, abs((overlay.strokeWidth ?? 2) - width) < 0.01 else { return false }
            let paths = source["inkPaths"] as? [[Double]] ?? [], requestedPaths = overlay.inkPaths ?? []
            if paths.count != requestedPaths.count { return false }
            for (a, b) in zip(paths, requestedPaths) { if a.count != b.count || zip(a,b).contains(where: { abs($0.0 - $0.1) > 0.01 }) { return false } }
        }
        return true
    }
    func pageInfo(_ token: String, _ number: Int) throws -> [String: Any] {
        let value = try entry(token), page = try page(value, number)
        let annotations = value.canAnnotate ? try sourceAnnotations(value, number) : []
        return ["view": bounds(page.bounds(for: .cropBox)), "rotation": ((page.rotation % 360) + 360) % 360, "annotations": annotations,
                "label": page.label ?? String(number), "links": links(page, in: value.document),
                "sourceAnnotationTypes": page.annotations.map { ($0.type ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) }]
    }
    private func links(_ page: PDFPage, in document: PDFDocument) -> [[String: Any]] {
        page.annotations.compactMap { annotation in
            guard annotation.shouldDisplay, (annotation.type ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased() == "link" else { return nil }
            let rect = bounds(annotation.bounds)
            guard rect.allSatisfy({ $0.isFinite }) else { return nil }
            if let url = annotation.url ?? (annotation.action as? PDFActionURL)?.url,
               let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) {
                return ["rect": rect, "url": url.absoluteString]
            }
            guard let destination = annotation.destination ?? (annotation.action as? PDFActionGoTo)?.destination,
                  let destinationPage = destination.page else { return nil }
            let index = document.index(for: destinationPage)
            guard index != NSNotFound, index >= 0, index < document.pageCount else { return nil }
            var result: [String: Any] = ["rect": rect, "page": index + 1]
            if destination.point.x.isFinite, destination.point.x != kPDFDestinationUnspecifiedValue { result["left"] = Double(destination.point.x) }
            if destination.point.y.isFinite, destination.point.y != kPDFDestinationUnspecifiedValue { result["top"] = Double(destination.point.y) }
            return result
        }
    }
    func render(_ args: PDFRenderArgs) throws -> [String: Any] {
        guard args.width > 0, args.height > 0, args.width <= 4096, args.height <= 4096,
              Int64(args.width) * Int64(args.height) <= 4_000_000, [0, 90, 180, 270].contains(args.rotation) else { throw error("El tamaño o la rotación del renderizado no son válidos.") }
        let value = try entry(args.token), page = try page(value, args.page)
        guard let cgPage = page.pageRef else { throw error("No se pudo leer la imagen de esta página.") }
        let space = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil, width: args.width, height: args.height, bitsPerComponent: 8, bytesPerRow: args.width * 4,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw error("No hay memoria disponible para dibujar esta página.") }
        context.setFillColor(UIColor.white.cgColor); context.fill(CGRect(x: 0, y: 0, width: args.width, height: args.height))
        // getDrawingTransform only scales down. Map the turned crop box at 1:1 and
        // scale explicitly so the page fills the bitmap, as the text layer expects.
        let box = page.bounds(for: .cropBox), turned = args.rotation % 180 != 0
        let size = CGSize(width: turned ? box.height : box.width, height: turned ? box.width : box.height)
        guard size.width > 0, size.height > 0 else { throw error("No se pudo mostrar esta página.") }
        context.scaleBy(x: CGFloat(args.width) / size.width, y: CGFloat(args.height) / size.height)
        context.concatenate(cgPage.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: Int32(args.rotation - page.rotation), preserveAspectRatio: true))
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
            var heading: [String: Any] = ["title": item.label ?? "", "page": NSNull(), "depth": depth]
            if let destination = item.destination ?? (item.action as? PDFActionGoTo)?.destination, let page = destination.page {
                let index = value.document.index(for: page)
                if index != NSNotFound, index >= 0, index < value.document.pageCount { heading["page"] = index + 1 }
            }
            result.append(heading)
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
        guard target.standardizedFileURL != URL(fileURLWithPath: value.args.path).standardizedFileURL else { throw error("No se pudo guardar la copia. El original no cambió.") }
        let changed = !args.annotations.isEmpty || !args.removedSourceRefs.isEmpty
        if !changed { try FileManager.default.copyItem(at: URL(fileURLWithPath: value.args.path), to: target); return ["path": target.path] }
        guard value.canAnnotate else { throw error("Este documento no permite modificar anotaciones.") }
        // Source references use the immutable raw /Annots array. PDFKit can
        // insert Popup annotations into its own array or discard CA/NM while
        // writing, so neither that index nor its writer is used for export.
        var unchanged = Set<String>()
        for overlay in args.annotations {
            guard let reference = overlay.nativeSourceRef else { continue }
            let parts = reference.split(separator: ":")
            if parts.count == 3, parts[0] == "pdfkit", let number = Int(parts[1]), number > 0,
               let source = try sourceAnnotations(value, number).first(where: { $0["nativeSourceRef"] as? String == reference }), matches(overlay, source) {
                unchanged.insert(reference)
            }
        }
        let replaced = Set(args.removedSourceRefs + args.annotations.compactMap { $0.nativeSourceRef }.filter { !unchanged.contains($0) })
        var removals = [FolioRemoval]()
        for reference in replaced {
            let parts = reference.split(separator: ":")
            guard parts.count == 3, parts[0] == "pdfkit", let number = Int(parts[1]), let index = Int(parts[2]), number > 0,
                  number <= value.document.pageCount, index >= 0, index <= Int(Int32.max),
                  try sourceAnnotations(value, number).contains(where: { $0["nativeSourceRef"] as? String == reference }) else { throw error("Una anotación de origen ya no coincide con el PDF.") }
            var removal = FolioRemoval(); removal.page = Int32(number); removal.index = Int32(index); removals.append(removal)
        }
        var nativeOverlays = [FolioOverlay](), strings = [UnsafeMutablePointer<CChar>](), geometries = [UnsafeMutablePointer<Float>]()
        var pathSizes = [UnsafeMutablePointer<Int32>]()
        defer { for pointer in strings { free(pointer) }; for pointer in geometries { pointer.deallocate() }; for pointer in pathSizes { pointer.deallocate() } }
        func string(_ text: String) throws -> UnsafePointer<CChar> {
            guard let pointer = strdup(text) else { throw error("No hay memoria para preparar las anotaciones.") }
            strings.append(pointer); return UnsafePointer(pointer)
        }
        for overlay in args.annotations {
            if let reference = overlay.nativeSourceRef, unchanged.contains(reference), !args.removedSourceRefs.contains(reference) { continue }
            guard ["highlight", "note", "ink"].contains(overlay.kind), overlay.rect.count == 4, overlay.rect.allSatisfy({ $0.isFinite }),
                  overlay.page > 0, overlay.page <= value.document.pageCount, overlay.created.isFinite,
                  abs(overlay.created / 1000) < Double(Int64.max) else { throw error("La anotación no tiene una página o posición válida.") }
            var rect = overlay.rect
            if overlay.kind == "note" {
                var width = 20.0, height = 20.0
                if let reference = overlay.nativeSourceRef, let original = try sourceAnnotations(value, overlay.page).first(where: { $0["nativeSourceRef"] as? String == reference }),
                   let raw = original["rawRect"] as? [Double], raw.count == 4 { width = raw[2] - raw[0]; height = raw[3] - raw[1] }
                rect = [overlay.rect[0], overlay.rect[1] - height, overlay.rect[0] + width, overlay.rect[1]]
            }
            guard rect[2] > rect[0], rect[3] > rect[1] else { throw error("La anotación tiene un tamaño inválido.") }
            var item = FolioOverlay(); item.page = Int32(overlay.page); item.kind = overlay.kind == "highlight" ? 1 : overlay.kind == "ink" ? 3 : 2
            item.rect = (Float(rect[0]), Float(rect[1]), Float(rect[2]), Float(rect[3]))
            let alpha = min(1, max(0, overlay.opacity ?? (overlay.kind == "highlight" ? 0.35 : 1)))
            item.opacity = Float(alpha); item.modified_seconds = Int64(overlay.created / 1000)
            let rgb = UInt32(overlay.color.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0xf5d76e
            item.color = (Float((rgb >> 16) & 255) / 255, Float((rgb >> 8) & 255) / 255, Float(rgb & 255) / 255)
            item.name = try string(overlay.originalName ?? overlay.id); item.contents = try string(overlay.text); item.author = try string(overlay.author ?? "Folio")
            if overlay.kind == "highlight" {
                let quads = overlay.quads ?? [[rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]]
                guard quads.allSatisfy({ $0.count == 8 && $0.allSatisfy({ $0.isFinite }) }) else { throw error("El resaltado contiene coordenadas inválidas.") }
                let flat = quads.flatMap { $0.map(Float.init) }, pointer = UnsafeMutablePointer<Float>.allocate(capacity: flat.count)
                flat.withUnsafeBufferPointer { if let base = $0.baseAddress { pointer.initialize(from: base, count: flat.count) } }
                geometries.append(pointer); item.quads = UnsafePointer(pointer); item.quad_count = quads.count
            }
            if overlay.kind == "ink" {
                let width = overlay.strokeWidth ?? 2
                guard width.isFinite, width > 0, width <= 50, let paths = overlay.inkPaths, !paths.isEmpty, paths.count <= 20000,
                      paths.allSatisfy({ $0.count >= 4 && $0.count <= 20000 && $0.count % 2 == 0 && $0.allSatisfy({ $0.isFinite && Float($0).isFinite }) }),
                      paths.reduce(0, { $0 + $1.count }) <= 1048576 else { throw error("El dibujo contiene coordenadas o grosor inválidos.") }
                let flat = paths.flatMap { $0.map(Float.init) }, pointer = UnsafeMutablePointer<Float>.allocate(capacity: flat.count)
                flat.withUnsafeBufferPointer { pointer.initialize(from: $0.baseAddress!, count: flat.count) }
                geometries.append(pointer)
                let sizes = paths.map { Int32($0.count) }, sizePointer = UnsafeMutablePointer<Int32>.allocate(capacity: sizes.count)
                sizes.withUnsafeBufferPointer { sizePointer.initialize(from: $0.baseAddress!, count: sizes.count) }
                pathSizes.append(sizePointer)
                item.ink_points = UnsafePointer(pointer); item.path_sizes = UnsafePointer(sizePointer); item.path_count = paths.count; item.stroke_width = Float(width)
            }
            nativeOverlays.append(item)
        }
        var message = [CChar](repeating: 0, count: 2048)
        let capacity = message.count
        let status = value.args.path.withCString { source in target.path.withCString { output in (value.args.password ?? "").withCString { password in
            nativeOverlays.withUnsafeBufferPointer { overlays in removals.withUnsafeBufferPointer { refs in
                folio_pdf_export(source, output, password, overlays.baseAddress, overlays.count, refs.baseAddress, refs.count, &message, capacity)
            } }
        } } }
        guard status == 0 else {
            // MuPDF reports in English for the log; the user gets the outcome.
            let detail = String(cString: message)
            NSLog("Folio annotation export failed: %@", detail)
            throw error(detail.hasPrefix("This PDF requires repair") ? "Este PDF está dañado. Folio no puede añadirle anotaciones sin modificar el original."
                : "No se pudo guardar la copia. El original no cambió.")
        }
        return ["path": target.path, "annotationWriter": "MuPDF " + String(cString: folio_pdf_engine_version()), "incremental": true]
    }
}
