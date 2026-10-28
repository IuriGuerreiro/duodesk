import Foundation

final class ConnectionRecovery {
  private let queue: DispatchQueue
  private let changed: (String) -> Void
  private let exhausted: () -> Void
  private let restart: () -> Void
  private var timer: DispatchWorkItem?
  private var deadline: DispatchWorkItem?
  private var active = false
  private var running = false
  private var attempt = 0
  private var generation = UUID()

  init(queue: DispatchQueue, changed: @escaping (String) -> Void,
       exhausted: @escaping () -> Void, restart: @escaping () -> Void) {
    self.queue = queue; self.changed = changed; self.exhausted = exhausted; self.restart = restart
  }

  var fields: [String: Any] {
    active ? ["attempt": attempt, "canReconnect": !running && attempt < 2] : [:]
  }

  private func after(_ seconds: Double, _ action: @escaping () -> Void) -> DispatchWorkItem {
    let generation = self.generation
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.active, self.generation == generation else { return }
      action()
    }
    queue.asyncAfter(deadline: .now() + seconds, execute: item)
    return item
  }

  func interrupt() {
    guard !active else { return }
    active = true; attempt = 0
    changed("interrupted")
    deadline = after(25) { [weak self] in self?.exhaust() }
    timer = after(3) { [weak self] in self?.reconnect() }
  }

  func reconnect() {
    guard active, !running else { return }
    guard attempt < 2 else { exhaust(); return }
    timer?.cancel()
    running = true; attempt += 1
    changed("reconnecting")
    timer = after(8) { [weak self] in
      guard let self else { return }
      self.running = false
      if self.attempt >= 2 { self.exhaust() }
      else {
        self.changed("interrupted")
        self.timer = self.after(2) { [weak self] in self?.reconnect() }
      }
    }
    restart()
  }

  func connected() {
    active = false; running = false; generation = UUID()
    timer?.cancel(); timer = nil
    deadline?.cancel(); deadline = nil
  }

  private func exhaust() {
    guard active else { return }
    connected(); exhausted()
  }
}
