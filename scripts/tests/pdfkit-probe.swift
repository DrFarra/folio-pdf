// Opens a PDF with PDFKit as Folio's iOS reader does (text, page drawing, outline)
// and prints the process footprint after each page: PDFKit on macOS shares
// CoreGraphics' parser with iOS, where the system ends an app that uses too much.
import Foundation
import PDFKit
import CoreGraphics

func footprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let status = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
    return status == KERN_SUCCESS ? info.phys_footprint : 0
}
let args = CommandLine.arguments
guard args.count >= 2, let document = PDFDocument(url: URL(fileURLWithPath: args[1])) else { print("cannot open"); exit(1) }
let pages = args.count > 2 ? args[2].split(separator: ",").compactMap { Int($0) } : [1, 2, 30, 112, 113, 500, 1000, 2000, 3000, 4000]
func mb(_ value: UInt64) -> Int { Int(value / 1_048_576) }
var peak = footprint()
print("open pages=\(document.pageCount) footprint=\(mb(peak))MB")
let started = Date()
var outlineCount = 0
func visit(_ item: PDFOutline) { outlineCount += 1; _ = item.destination?.page; for i in 0..<item.numberOfChildren { if let c = item.child(at: i) { visit(c) } } }
if let root = document.outlineRoot { visit(root) }
print("outline \(outlineCount) entries footprint=\(mb(footprint()))MB")
for number in pages where number <= document.pageCount {
    let t = Date()
    autoreleasepool {
        guard let page = document.page(at: number - 1) else { return }
        let text = page.string ?? ""
        _ = page.annotations.count
        let context = CGContext(data: nil, width: 1200, height: 1600, bitsPerComponent: 8, bytesPerRow: 4800, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 1200, height: 1600))
        if let cg = page.pageRef { context.concatenate(cg.getDrawingTransform(.cropBox, rect: CGRect(x: 0, y: 0, width: 1200, height: 1600), rotate: 0, preserveAspectRatio: true)); context.drawPDFPage(cg) }
        let now = footprint(); peak = max(peak, now)
        print(String(format: "page %d text=%d %.2fs footprint=%dMB", number, text.count, Date().timeIntervalSince(t), mb(now)))
    }
}
print(String(format: "done %.1fs peak=%dMB", Date().timeIntervalSince(started), mb(peak)))
