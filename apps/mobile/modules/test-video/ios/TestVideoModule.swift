import ExpoModulesCore
import UIKit

public final class TestVideoModule: Module {
  private let pairing = PairingTransport()
  private let pairingQueue = DispatchQueue(label: "duodesk.pairing")
  private let queue = DispatchQueue(label: "duodesk.sender")
  private var trust: TrustManager?
  private var backgroundObserver: NSObjectProtocol?
  private lazy var sender = VideoSender(queue: queue) { [weak self] event in self?.sendEvent("onStatus", event) }

  public func definition() -> ModuleDefinition {
    Name("DuoDeskTestVideo")
    Constant("supportsRemembered") { true }
    Events("onStatus", "onTrust")
    OnCreate {
      self.trust = TrustManager(event: { [weak self] event in self?.sendEvent("onTrust", event) }, endSession: { [weak self] in self?.queue.async { [weak self] in self?.sender.stop() } })
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
      ) { [weak self] _ in
        _ = try? self?.trust?.command("foreground", ["active": false])
        self?.pairing.close()
        self?.queue.async { [weak self] in self?.sender.stop() }
      }
    }
    AsyncFunction("trustCommand") { (method: String, text: String) throws -> String in
      guard let args = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let trust = self.trust else { throw TrustFailure("Remembered devices unavailable") }
      return try trust.command(method, args)
    }
    AsyncFunction("pairRequest") { (address: String, message: String, fresh: Bool, promise: Promise) in
      let ticket = self.pairing.ticket()
      self.pairingQueue.async {
        do { promise.resolve(try self.pairing.request(address: address, message: message, fresh: fresh, ticket: ticket)) }
        catch { self.pairing.close(); promise.reject(error) }
      }
    }
    AsyncFunction("pairClose") { self.pairing.close() }
    AsyncFunction("connect") { (invitation: String) in try self.sender.connect(invitation) }.runOnQueue(queue)
    AsyncFunction("start") { (bitrateMbps: Int) in
      do { try self.sender.start(bitrateMbps: bitrateMbps) }
      catch { self.sender.stop(); throw error }
    }.runOnQueue(queue)
    AsyncFunction("reconnect") { self.sender.reconnect() }.runOnQueue(queue)
    AsyncFunction("stop") { self.sender.stop() }.runOnQueue(queue)
    OnDestroy {
      self.trust?.destroy(); self.trust = nil
      self.pairing.close()
      if let observer = self.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
      self.backgroundObserver = nil
      self.queue.async { self.sender.close() }
    }
  }
}
