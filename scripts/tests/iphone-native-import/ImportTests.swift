import XCTest

final class ImportTests: XCTestCase {
    private let folio = XCUIApplication(bundleIdentifier: "org.folio.pdf")
    private let host = XCUIApplication(bundleIdentifier: "org.folio.import-ui-host")
    override func setUpWithError() throws { continueAfterFailure = false }
    private func attach(_ name: String, app: XCUIApplication) {
        let screen = XCTAttachment(screenshot: app.screenshot()); screen.name = name; screen.lifetime = .keepAlways; add(screen)
        let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    private func prepareHost() {
        host.launch()
        let status = host.staticTexts["host-status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 10), "The import host did not publish fixture preparation status")
        attach("host-fixtures-status", app: host)
        XCTAssertEqual(status.label, "4 PDFs prepared", "The real file provider must contain all four original PDFs before UIKit interaction")
    }
    private func reading(_ text: String, screenshot: String) {
        XCTAssertTrue(folio.wait(for: .runningForeground, timeout: 45), "iOS did not foreground Folio")
        let rendered = folio.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(rendered.waitForExistence(timeout: 45), "The actual PDF text did not appear: " + text)
        XCTAssertTrue(folio.textFields["Número de página"].firstMatch.waitForExistence(timeout: 10), "No reading page control")
        XCTAssertEqual(folio.textFields["Número de página"].firstMatch.value as? String, "1")
        attach(screenshot, app: folio)
    }
    private func openPicker() {
        let plus = folio.buttons["Abrir PDF"].firstMatch
        XCTAssertTrue(plus.waitForExistence(timeout: 15)); XCTAssertTrue(plus.isEnabled)
        plus.tap()
        XCTAssertTrue(folio.buttons["Cancel"].firstMatch.waitForExistence(timeout: 15), "UIDocumentPicker did not appear")
    }
    private func select(_ filename: String) {
        let basename = (filename as NSString).deletingPathExtension
        func fixture() -> XCUIElement {
            return folio.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label == %@ OR label BEGINSWITH %@", filename, basename, filename + ",")).firstMatch
        }
        if !fixture().waitForExistence(timeout: 4) {
            // directoryURL only selects the initial real provider location; the
            // following fallback still navigates UIKit through visible controls.
            let browse = folio.buttons["Browse"].firstMatch
            if browse.exists && browse.isHittable { browse.tap() }
            let local = folio.descendants(matching: .any).matching(NSPredicate(format: "label == 'On My iPhone' OR label == 'On My iPad'")).firstMatch
            XCTAssertTrue(local.waitForExistence(timeout: 8)); local.tap()
            let folder = folio.descendants(matching: .any).matching(NSPredicate(format: "label == 'Folio Import Host' OR label == 'FolioImportHost' OR label BEGINSWITH 'Folio Import Host,' OR label BEGINSWITH 'FolioImportHost,'")).firstMatch
            XCTAssertTrue(folder.waitForExistence(timeout: 8)); folder.tap()
        }
        let file = fixture(); XCTAssertTrue(file.waitForExistence(timeout: 15), "The actual picker did not show " + filename)
        attach("picker-" + basename, app: folio); file.tap()
        // Multiple selection requires the picker Open confirmation on iOS.
        let confirm = folio.buttons["Open"].firstMatch
        if confirm.waitForExistence(timeout: 2) && confirm.isHittable { XCTAssertTrue(confirm.isEnabled); confirm.tap() }
    }
    func test01CancelThenSelectTwoActualProviderDocuments() {
        prepareHost()
        XCTAssertTrue(host.buttons["openin-cold"].firstMatch.waitForExistence(timeout: 10))
        folio.launchArguments = ["--folio-ui-test-picker", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        folio.launch()
        XCTAssertFalse(folio.textFields["Número de página"].firstMatch.exists, "This test must start without argv/seeded startup PDF")
        openPicker(); folio.buttons["Cancel"].firstMatch.tap()
        XCTAssertTrue(folio.buttons["Abrir PDF"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(folio.textFields["Número de página"].firstMatch.exists, "Cancel created a reading document")
        attach("picker-canceled", app: folio)
        openPicker(); select("Folio selección uno.PDF")
        reading("FOLIO PICKER UNO", screenshot: "picker-open-one")
        openPicker(); select("Folio selección dos.pdf")
        reading("FOLIO PICKER DOS", screenshot: "picker-open-two")
        folio.buttons["Documentos abiertos"].firstMatch.tap()
        XCTAssertTrue(folio.buttons["Abrir pestaña Folio selección uno.PDF"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(folio.buttons["Abrir pestaña Folio selección dos.pdf"].firstMatch.exists)
        attach("picker-two-tabs", app: folio)
        folio.buttons["Cerrar diálogo"].firstMatch.tap()
    }
    private func send(_ identifier: String) {
        prepareHost(); let button = host.buttons[identifier].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 10)); button.tap()
        let folioAction = host.buttons.matching(NSPredicate(format: "label == 'Folio' OR label == 'Copy to Folio' OR label == 'Open in Folio'")).firstMatch
        XCTAssertTrue(folioAction.waitForExistence(timeout: 15), "iOS Open In menu did not offer Folio")
        attach("openin-menu-" + identifier, app: host); folioAction.tap()
    }
    func test02ActualOpenInColdAndWarmWithModal() {
        folio.terminate()
        send("openin-cold")
        reading("FOLIO OPENIN FRIO", screenshot: "openin-cold-opened")
        folio.buttons["Más acciones"].firstMatch.tap()
        XCTAssertTrue(folio.staticTexts["Acciones del documento"].firstMatch.waitForExistence(timeout: 10))
        send("openin-warm")
        XCTAssertTrue(folio.wait(for: .runningForeground, timeout: 45))
        // A system URL arriving while the modal is open must be queued until
        // the user closes it. No JS event or delegate is injected by this test.
        XCTAssertTrue(folio.buttons["Cerrar diálogo"].firstMatch.waitForExistence(timeout: 10))
        folio.buttons["Cerrar diálogo"].firstMatch.tap()
        reading("FOLIO OPENIN CALIENTE", screenshot: "openin-warm-opened")
    }
}
