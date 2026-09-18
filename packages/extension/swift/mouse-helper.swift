// Mouse mode for Grapher: streams drags, clicks, scrolls and pinches over
// Raycast's window to the extension as JSON lines on stdout.
//
// It only observes events through a global monitor, which macOS allows for
// mouse input without any permission, so Raycast still receives everything too.
// Positions are in points from the window's top-left corner, with the window's
// size alongside, so the extension can place them on the plot.
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
setvbuf(stdout, nil, _IOLBF, 0)

/// The pointer in global display coordinates from the top-left, the same ones the window list uses.
/// Reading them straight from Quartz avoids flipping AppKit's coordinates, which goes wrong with several displays.
func pointer() -> CGPoint {
  CGEvent(source: nil)?.location ?? .zero
}

/// Windows that sit over everything without taking the pointer, so they don't count as being on top.
let overlays: Set<String> = ["Window Server", "Dock", "SystemUIServer", "Control Center", "Notification Center"]

/// The topmost visible window under the pointer, front to back.
func topWindow(at point: CGPoint) -> (owner: String, frame: CGRect)? {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
    guard alpha > 0.01, !overlays.contains(owner),
      let bounds = window[kCGWindowBounds as String],
      let frame = CGRect(dictionaryRepresentation: bounds as! CFDictionary),
      frame.contains(point)
    else { continue }
    return (owner, frame)
  }
  return nil
}

/// Raycast's window, when it's what the pointer is over. Raycast opens as a panel that
/// doesn't make it the active app, so being on top under the pointer is the test, not being frontmost.
func raycastWindow(at point: CGPoint) -> CGRect? {
  guard let top = topWindow(at: point), top.owner.hasPrefix("Raycast"), top.frame.width > 300 else { return nil }
  return top.frame
}

var lastExplained = Date.distantPast

func emit(_ type: String, _ extra: [String: Any] = [:]) {
  let point = pointer()
  guard let window = raycastWindow(at: point) else {
    if Date().timeIntervalSince(lastExplained) > 2 {
      lastExplained = Date()
      let top = topWindow(at: point).map { "\($0.owner) \(Int($0.frame.width))x\(Int($0.frame.height))" } ?? "nothing"
      log("ignoring \(type) at \(Int(point.x)),\(Int(point.y)); on top there: \(top)")
    }
    return
  }
  var fields: [String: Any] = [
    "type": type, "x": point.x - window.minX, "y": point.y - window.minY, "width": window.width, "height": window.height,
  ]
  fields.merge(extra) { _, new in new }
  if let data = try? JSONSerialization.data(withJSONObject: fields), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

var pressedAt: CGPoint?
var dragging = false

func log(_ message: String) {
  FileHandle.standardError.write(Data((message + "\n").utf8))
}

// The first event of each kind is logged, which shows in `ray develop` output.
var reported = Set<UInt>()
func note(_ event: NSEvent) {
  if reported.insert(event.type.rawValue).inserted { log("saw \(event.type)") }
}

let watched: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel, .magnify, .gesture]

_ = NSEvent.addGlobalMonitorForEvents(matching: watched) { event in
  note(event)
  switch event.type {
  case .leftMouseDown:
    pressedAt = pointer()
    dragging = false
  case .leftMouseDragged:
    guard let start = pressedAt else { return }
    let now = pointer()
    // A few points of wobble is still a click.
    if !dragging && hypot(now.x - start.x, now.y - start.y) < 4 { return }
    dragging = true
    emit("drag", ["dx": event.deltaX, "dy": event.deltaY])
  case .leftMouseUp:
    // A drag's end matters too: it lets go of a slider.
    if pressedAt != nil { emit(dragging ? "up" : "click") }
    pressedAt = nil
    dragging = false
  case .scrollWheel:
    // Command or option with a scroll zooms, which works where trackpad pinches may not reach us.
    let zooming = event.modifierFlags.intersection([.command, .option]).isEmpty == false
    emit("scroll", [
      "dx": event.scrollingDeltaX, "dy": event.scrollingDeltaY, "precise": event.hasPreciseScrollingDeltas, "zooming": zooming,
    ])
  case .magnify:
    emit("pinch", ["amount": event.magnification])
  default:
    break
  }
}

// Grapher closes stdin when its command closes; exit with it.
FileHandle.standardInput.readabilityHandler = { handle in
  if handle.availableData.isEmpty { exit(0) }
}
log("listening")
app.run()
