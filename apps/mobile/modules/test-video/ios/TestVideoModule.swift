import ExpoModulesCore
import UIKit

public final class TestVideoModule: Module {
  private let queue = DispatchQueue(label: "duodesk.sender")
  private var backgroundObserver: NSObjectProtocol?
  private lazy var sender = VideoSender(queue: queue) { [weak self] event in self?.sendEvent("onStatus", event) }

  public func definition() -> ModuleDefinition {
    Name("DuoDeskTestVideo")
    Events("onStatus")
    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
      ) { [weak self] _ in self?.queue.async { [weak self] in self?.sender.stop() } }
    }
    AsyncFunction("connect") { (invitation: String) in try self.sender.connect(invitation) }.runOnQueue(queue)
    AsyncFunction("start") { (bitrateMbps: Int) in
      do { try self.sender.start(bitrateMbps: bitrateMbps) }
      catch { self.sender.stop(); throw error }
    }.runOnQueue(queue)
    AsyncFunction("stop") { self.sender.stop() }.runOnQueue(queue)
    OnDestroy {
      if let observer = self.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
      self.backgroundObserver = nil
      self.queue.async { self.sender.close() }
    }
  }
}
