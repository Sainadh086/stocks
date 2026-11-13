import Foundation
import LocalAuthentication
import AppKit

// Fingerprints remain inside macOS. Only the verification result is returned.
func finish(_ verified: Bool, _ message: String = "") -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["verified": verified, "message": message])
    FileHandle.standardOutput.write(data)
    exit(0)
}

let context = LAContext()
context.localizedFallbackTitle = ""
context.touchIDAuthenticationAllowableReuseDuration = 0
var availabilityError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &availabilityError),
      context.biometryType == .touchID else {
    finish(false, "Touch ID is unavailable or locked. Unlock your Mac and check Touch ID in System Settings.")
}
if CommandLine.arguments.contains("--check") { finish(true) }
let action = CommandLine.arguments.dropFirst().first ?? ""
let reasons = [
    "pair": "Approve connecting a phone to your Varshan portfolio.",
    "privacy": "Reveal private holdings values, quantities and portfolio graphs in Varshan."
]
guard let reason = reasons[action] else { finish(false, "Unknown verification request.") }
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.activate(ignoringOtherApps: true)
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, _ in
    finish(success, success ? "" : "Touch ID verification was cancelled or failed. Nothing was changed.")
}
RunLoop.main.run()
