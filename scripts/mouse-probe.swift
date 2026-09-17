// Feasibility probe for a mouse mode: prints the drags, scrolls and pinches macOS
// lets an ordinary process observe in other apps, with the Raycast window's frame,
// and whether the process holds accessibility permission.
//
//   swiftc -O scripts/mouse-probe.swift -o /tmp/mouse-probe && /tmp/mouse-probe 30
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

/// Raycast's frontmost on-screen window, from the window list, which needs no permission for bounds.
func raycastFrame() -> CGRect? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
  for window in windows where (window[kCGWindowOwnerName as String] as? String)?.hasPrefix("Raycast") == true {
    if let bounds = window[kCGWindowBounds as String], let rect = CGRect(dictionaryRepresentation: bounds as! CFDictionary),
       rect.width > 300 {
      return rect
    }
  }
  return nil
}

let watched: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDragged, .scrollWheel, .magnify]
_ = NSEvent.addGlobalMonitorForEvents(matching: watched) { event in
  let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"
  let at = NSEvent.mouseLocation
  var line = "\(event.type) front=\(front) at=(\(Int(at.x)), \(Int(at.y)))"
  switch event.type {
  case .leftMouseDragged, .rightMouseDragged: line += " drag=(\(event.deltaX), \(event.deltaY))"
  case .scrollWheel: line += " scroll=(\(event.scrollingDeltaX), \(event.scrollingDeltaY)) precise=\(event.hasPreciseScrollingDeltas)"
  case .magnify: line += " pinch=\(event.magnification)"
  default: break
  }
  if let frame = raycastFrame() { line += " raycast=\(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height))" }
  print(line)
  fflush(stdout)
}

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "20") ?? 20
print("listening for \(Int(seconds))s; accessibility trusted: \(AXIsProcessTrusted()); raycast window: \(raycastFrame().map { "\($0)" } ?? "not on screen")")
fflush(stdout)
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
app.run()
