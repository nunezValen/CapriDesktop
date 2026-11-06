import AppKit
import ApplicationServices
import Carbon

func emit(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
}
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func label(_ element: AXUIElement) -> String {
    for name in [kAXTitleAttribute, kAXDescriptionAttribute] {
        if let text = attr(element, name) as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
    }
    return ""
}
func spotifyResultTable(_ table: AXUIElement) -> Bool {
    let text = label(table).lowercased()
    return (attr(table, kAXRoleAttribute) as? String) == "AXTable" && (text.contains("search results") || text.contains("all songs for") || text.contains("resultados") || text.contains("todas las canciones"))
}
func windows(_ onlyPid: pid_t? = nil) -> [[String: Any]] {
    guard AXIsProcessTrusted() else { return [] }
    var result: [[String: Any]] = []
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let cgWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let apps = NSWorkspace.shared.runningApplications.sorted { ($0.processIdentifier == front ? 0 : 1) < ($1.processIdentifier == front ? 0 : 1) }
    for app in apps where app.activationPolicy == .regular && !app.isHidden {
        if let pid = onlyPid, app.processIdentifier != pid { continue }
        if app.bundleIdentifier == "dev.cybercompanion.capri" || app.localizedName == "Electron" || app.localizedName == "Capri Desktop" { continue }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        let items = attr(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
        for (index, item) in items.enumerated() {
            if (attr(item, kAXMinimizedAttribute) as? Bool) == true { continue }
            var point = CGPoint.zero
            var size = CGSize.zero
            guard let p = attr(item, kAXPositionAttribute), let s = attr(item, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { continue }
            guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { continue }
            // AX uses top-left global points, matching Electron DIP coordinates, including negative origins.
            let cg = cgWindows.first { entry in
                guard (entry[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier,
                      let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat] else { return false }
                return abs((bounds["X"] ?? 0) - point.x) < 4 && abs((bounds["Y"] ?? 0) - point.y) < 4 && abs((bounds["Width"] ?? 0) - size.width) < 4 && abs((bounds["Height"] ?? 0) - size.height) < 4
            }
            let identifier = (cg?[kCGWindowNumber as String] as? NSNumber)?.stringValue ?? (attr(item, kAXIdentifierAttribute) as? String)
            result.append(["hwnd": "\(app.processIdentifier):\(identifier ?? String(index))", "pid": app.processIdentifier,
                "title": attr(item, kAXTitleAttribute) as? String ?? "", "process": app.localizedName ?? "", "path": app.bundleURL?.path ?? "",
                "left": point.x, "top": point.y, "width": size.width, "height": size.height,
                "isBrowser": ["safari", "chrome", "firefox", "brave", "edge", "opera"].contains { (app.localizedName ?? "").lowercased().contains($0) },
                "frontmost": app.processIdentifier == front])
        }
    }
    return result
}
func descendants(_ root: AXUIElement, limit: Int = 6000) -> [AXUIElement] {
    var queue = [root]
    var index = 0
    while index < queue.count && queue.count < limit {
        let children = attr(queue[index], kAXChildrenAttribute) as? [AXUIElement] ?? []
        queue.append(contentsOf: children.prefix(limit - queue.count))
        index += 1
    }
    return queue
}
func normalized(_ text: String) -> String {
    return text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
}
func spotifySearch(_ query: String) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["error": "Desktop helper Accessibility access is denied. Enable Capri Desktop in System Settings and restart."] }
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.spotify.client" }) else { return ["error": "Spotify is not open."] }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return ["error": "Spotify lost focus; search cancelled."] }
    // Type literal Unicode into Spotify's own search box. Search URI handlers can turn spaces into '+' characters.
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    func searchInput() -> AXUIElement? {
        let nodes=descendants(root)
        let fields=nodes.filter { ["AXComboBox", "AXSearchField", "AXTextField"].contains(attr($0,kAXRoleAttribute) as? String ?? "") }
        if let named=fields.first(where: { element in
            let text = ([label(element), attr(element,"AXHelp") as? String ?? "", attr(element,"AXPlaceholderValue") as? String ?? ""].joined(separator:" ")).lowercased()
            return (text.contains("what do you want") || text.contains("search") || text.contains("buscar")) && !text.contains("library")
        }) { return named }
        // Spotify Home sometimes exposes only an unnamed editable combo box.
        // Identify the field in its top navigation bar, never a library/filter input.
        guard let window=(attr(root,kAXWindowsAttribute) as? [AXUIElement])?.first,
              let value=attr(window,kAXPositionAttribute), CFGetTypeID(value)==AXValueGetTypeID() else { return nil }
        var origin=CGPoint.zero
        guard AXValueGetValue(value as! AXValue,.cgPoint,&origin) else { return nil }
        return fields.first(where: { element in
            guard (attr(element,kAXRoleAttribute) as? String)=="AXComboBox",
                  let value=attr(element,kAXPositionAttribute), CFGetTypeID(value)==AXValueGetTypeID() else { return false }
            var position=CGPoint.zero
            guard AXValueGetValue(value as! AXValue,.cgPoint,&position), position.y >= origin.y, position.y < origin.y+110 else { return false }
            let text=label(element).lowercased()
            if ["library","recents","sort"].contains(where:{text.contains($0)}) { return false }
            var editable: DarwinBoolean=false
            return AXUIElementIsAttributeSettable(element,kAXValueAttribute as CFString,&editable) == .success && editable.boolValue
        })
    }
    var input = searchInput()
    if input == nil {
        let nodes=descendants(root)
        if let search=nodes.first(where: { element in
            let role=attr(element,kAXRoleAttribute) as? String ?? ""
            return ["AXButton","AXLink"].contains(role) && ["search","buscar","rechercher","suchen"].contains(label(element).lowercased())
        }) { AXUIElementPerformAction(search,kAXPressAction as CFString) }
        for _ in 0..<3 {
            Thread.sleep(forTimeInterval:0.15)
            input=searchInput()
            if input != nil { break }
        }
    }
    guard let input = input else { return ["retryable":true,"error":"Spotify search is still opening. Try again in a moment."] }
    guard AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { return ["error": "Could not focus Spotify search."] }
    // Chromium's native AX SetValue replaces the whole field and dispatches its input change.
    // Synthetic Command-A can be ignored by Spotify and accidentally append duplicate text.
    guard AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, query as CFString) == .success else { return ["error": "Could not replace Spotify search text."] }
    return ["typed": true]
}
func spotifySubmit(_ query: String) -> [String: Any] {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.spotify.client" }) else { return ["error": "Spotify or Accessibility access unavailable."] }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return ["error": "Spotify lost focus; search cancelled."] }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let nodes = descendants(root)
    guard nodes.contains(where: { element in
        ["AXComboBox", "AXSearchField", "AXTextField"].contains(attr(element, kAXRoleAttribute) as? String ?? "") && normalized(attr(element, kAXValueAttribute) as? String ?? "") == normalized(query)
    }) else { return ["error": "Spotify search text did not update. Try again."] }
    // Prefer Spotify's explicit suggestions action after React has processed the new input.
    if let button = nodes.first(where: { element in
        let label = (attr(element, kAXDescriptionAttribute) as? String ?? "") + " " + (attr(element, kAXTitleAttribute) as? String ?? "")
        return (attr(element, kAXRoleAttribute) as? String) == "AXButton" && label.lowercased().contains("view all results") && normalized(label).contains(normalized(query))
    }), AXUIElementPerformAction(button, kAXPressAction as CFString) == .success { return ["submitted": true] }
    for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down)?.postToPid(app.processIdentifier) }
    return ["submitted": true]
}
func spotifyResult(_ query: String) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["error": "Allow Accessibility for Capri Desktop in System Settings."] }
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.spotify.client" }) else { return ["error": "Spotify is not open."] }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return ["error": "Spotify lost focus; search cancelled."] }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let nodes = descendants(root)
    let q = normalized(query)
    guard nodes.contains(where: { element in
        let role = attr(element, kAXRoleAttribute) as? String ?? ""
        return ["AXComboBox", "AXTextField", "AXSearchField"].contains(role) && normalized(attr(element, kAXValueAttribute) as? String ?? "") == q
    }) else { return ["waiting": true] }
    var candidates: [[String: String]] = []
    var seen = Set<String>()
    for table in nodes where spotifyResultTable(table) {
        for row in descendants(table) where (attr(row, kAXRoleAttribute) as? String) == "AXRow" {
            let contents = descendants(row, limit: 200)
            let links = contents.filter { (attr($0, kAXRoleAttribute) as? String) == "AXLink" }
            var artistNames: [String] = []
            for link in links {
                let value = attr(link, "AXURL")
                let url = (value as? URL)?.absoluteString ?? (value as? String) ?? (attr(link, kAXValueAttribute) as? String ?? "")
                if url.contains("/artist/") {
                    let name = label(link)
                    if !name.isEmpty { artistNames.append(name) }
                }
            }
            // Song-only pages expose the title as text and a scoped Play button, without track links.
            if !links.contains(where: { element in
                let value = attr(element, "AXURL")
                let url = (value as? URL)?.absoluteString ?? (value as? String) ?? (attr(element, kAXValueAttribute) as? String ?? "")
                return url.contains("/track/")
            }), let button = contents.first(where: { (attr($0, kAXRoleAttribute) as? String) == "AXButton" && label($0).hasPrefix("Play ") && label($0).contains(" by ") }) {
                let key = label(button)
                let parts = String(key.dropFirst(5)).components(separatedBy: " by ")
                if parts.count >= 2 && !seen.contains(key) {
                    seen.insert(key)
                    candidates.append(["key":key,"title":parts.dropLast().joined(separator:" by "),"artist":parts.last!])
                    if candidates.count >= 20 { return ["candidates": candidates] }
                }
            }
            for link in links {
                let value = attr(link, "AXURL")
                let url = (value as? URL)?.absoluteString ?? (value as? String) ?? (attr(link, kAXValueAttribute) as? String ?? "")
                if let range = url.range(of: "/track/") {
                    let id = String(url[range.upperBound...].prefix(while: { $0.isLetter || $0.isNumber }))
                    if id.count == 22 && !seen.contains(id) {
                        seen.insert(id)
                        candidates.append(["uri": "spotify:track:" + id, "title": label(link), "artist": artistNames.joined(separator: ", ")])
                        if candidates.count >= 20 { return ["candidates": candidates] }
                    }
                }
            }
        }
    }
    if !candidates.isEmpty { return ["candidates": candidates] }
    return ["waiting": true]
}
func spotifyPlayResult(_ query: String, _ key: String) -> [String: Any] {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.spotify.client" }) else { return ["error":"Spotify or Accessibility access unavailable."] }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return ["error":"Spotify lost focus; playback cancelled."] }
    let nodes=descendants(AXUIElementCreateApplication(app.processIdentifier))
    guard nodes.contains(where: { ["AXComboBox","AXSearchField","AXTextField"].contains(attr($0,kAXRoleAttribute) as? String ?? "") && normalized(attr($0,kAXValueAttribute) as? String ?? "") == normalized(query) }) else { return ["error":"The Spotify search changed; playback cancelled."] }
    for table in nodes where spotifyResultTable(table) {
        for row in descendants(table) where (attr(row,kAXRoleAttribute) as? String) == "AXRow" {
            if let button=descendants(row,limit:200).first(where: { (attr($0,kAXRoleAttribute) as? String) == "AXButton" && label($0) == key }), AXUIElementPerformAction(button,kAXPressAction as CFString) == .success { return ["pressed":true] }
        }
    }
    return ["error":"The selected song row is no longer available."]
}
func automationStatus(_ bundle: String) -> String {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundle)
    let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false)
    if status == noErr { return "granted" }
    if status == OSStatus(errAEEventWouldRequireUserConsent) { return "not-determined" }
    if status == OSStatus(errAEEventNotPermitted) { return "denied" }
    return "unavailable"
}
let args = Array(CommandLine.arguments.dropFirst())
switch args.first ?? "status" {
case "status": emit(["accessibility": AXIsProcessTrusted(), "spotifyAutomation": automationStatus("com.spotify.client"), "systemEventsAutomation": automationStatus("com.apple.systemevents")])
case "request-accessibility":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    emit(["accessibility": AXIsProcessTrustedWithOptions(options)])
case "windows": emit(windows())
case "spotify-search": emit(spotifySearch(args.dropFirst().first ?? ""))
case "spotify-submit": emit(spotifySubmit(args.dropFirst().first ?? ""))
case "spotify-play-result": emit(spotifyPlayResult(args.dropFirst().first ?? "", args.dropFirst(2).first ?? ""))
case "spotify-result": emit(spotifyResult(args.dropFirst().first ?? ""))
case "foreground":
    if let app = NSWorkspace.shared.frontmostApplication {
        let w = windows(app.processIdentifier).first { ($0["pid"] as? Int32) == app.processIdentifier }
        var result: [String: Any] = ["title": w?["title"] ?? "", "process": app.localizedName ?? "", "path": app.bundleURL?.path ?? "", "pid": app.processIdentifier]
        if let w = w { result["bounds"] = ["x": w["left"] ?? 0, "y": w["top"] ?? 0, "width": w["width"] ?? 0, "height": w["height"] ?? 0] }
        emit(result)
    } else { emit([:]) }
case "processes": emit(NSWorkspace.shared.runningApplications.map { ["pid": $0.processIdentifier, "name": $0.localizedName ?? "", "bundle": $0.bundleIdentifier ?? ""] as [String: Any] })
case "quit":
    let wanted = args.dropFirst().map { $0.lowercased().replacingOccurrences(of: ".exe", with: "") }
    let matched = NSWorkspace.shared.runningApplications.filter { app in
        app.processIdentifier != ProcessInfo.processInfo.processIdentifier && app.bundleIdentifier != "dev.cybercompanion.capri" && app.localizedName != "Electron" && wanted.contains { $0 == (app.localizedName ?? "").lowercased() || $0 == (app.bundleIdentifier ?? "").lowercased() }
    }
    emit(["requested": matched.filter { $0.terminate() }.count])
default: emit(["error": "Unknown command"]); exit(1)
}
