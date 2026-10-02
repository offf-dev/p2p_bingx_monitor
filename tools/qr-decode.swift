// Распознаёт QR на картинке штатной macOS Vision — без установки чего-либо.
// Используется из decode-ga-export.py, но работает и отдельно:
//     swift tools/qr-decode.swift ~/Downloads/qr.png
// Печатает содержимое каждого найденного QR по строке на штуку.
import Foundation
import Vision
import AppKit

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count > 1 else {
    fail("использование: swift qr-decode.swift <картинка>", 2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("не читается картинка: \(url.path)", 3)
}

let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
    fail("Vision не смогла обработать картинку: \(error.localizedDescription)", 4)
}

let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
guard !payloads.isEmpty else { fail("QR не найден", 1) }
payloads.forEach { print($0) }
