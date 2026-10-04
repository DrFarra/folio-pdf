import UIKit
import UniformTypeIdentifiers

// A separate sender app exercises iOS document interaction. It never invokes
// Folio's Rust/Swift bridge and is never included in the distributed Folio IPA.
@main final class ImportHostDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UINavigationController(rootViewController: ImportHostController())
        self.window = window
        window.makeKeyAndVisible()
        return true
    }
}

final class ImportHostController: UIViewController, UIDocumentInteractionControllerDelegate {
    private var interaction: UIDocumentInteractionController?
    private let status = UILabel()
    private let fixtures = [
        ("openin-cold", "Folio envío frío.PDF", "Enviar PDF frío"),
        ("openin-warm", "Folio envío caliente.pdf", "Enviar PDF caliente")
    ]
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Folio Import Host"
        view.backgroundColor = .systemBackground
        // This helper alone exposes its Documents through Apple's local file
        // provider. Folio retains its production import-by-copy configuration.
        do {
            let manager = FileManager.default
            let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            for filename in ["Folio selección uno.PDF", "Folio selección dos.pdf", "Folio envío frío.PDF", "Folio envío caliente.pdf"] {
                guard let bundled = Bundle.main.url(forResource: (filename as NSString).deletingPathExtension, withExtension: (filename as NSString).pathExtension) else {
                    throw NSError(domain: "FolioImportHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing fixture " + filename])
                }
                let destination = documents.appendingPathComponent(filename)
                if !manager.fileExists(atPath: destination.path) { try manager.copyItem(at: bundled, to: destination) }
            }
        } catch { status.text = "Import host setup error: " + error.localizedDescription }
        let stack = UIStackView()
        stack.axis = .vertical; stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor)
        ])
        for (identifier, filename, title) in fixtures {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal); button.accessibilityIdentifier = identifier
            button.heightAnchor.constraint(equalToConstant: 52).isActive = true
            button.addAction(UIAction { [weak self, weak button] _ in
                guard let self = self, let button = button else { return }
                self.send(filename, from: button)
            }, for: .touchUpInside)
            stack.addArrangedSubview(button)
        }
        status.numberOfLines = 0; status.accessibilityIdentifier = "host-status"
        stack.addArrangedSubview(status)
    }
    private func send(_ filename: String, from button: UIButton) {
        do {
            let manager = FileManager.default
            let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            guard let bundled = Bundle.main.url(forResource: (filename as NSString).deletingPathExtension, withExtension: (filename as NSString).pathExtension) else {
                throw NSError(domain: "FolioImportHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing fixture " + filename])
            }
            let file = documents.appendingPathComponent(filename)
            if !manager.fileExists(atPath: file.path) { try manager.copyItem(at: bundled, to: file) }
            let controller = UIDocumentInteractionController(url: file)
            controller.uti = UTType.pdf.identifier; controller.name = filename; controller.delegate = self
            interaction = controller
            let shown = controller.presentOpenInMenu(from: button.bounds, in: button, animated: true)
            status.text = shown ? "Open In menu presented" : "No Open In handler"
        } catch { status.text = "Import host error: " + error.localizedDescription }
    }
    func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController) -> UIViewController { self }
}
