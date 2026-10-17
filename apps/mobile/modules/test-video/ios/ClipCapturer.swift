import AVFoundation
import QuartzCore
import WebRTC

/// A bounded, real-time source. Decode one frame ahead and discard late frames.
final class ClipCapturer: RTCVideoCapturer {
  private let queue = DispatchQueue(label: "duodesk.clip")
  private var timer: DispatchSourceTimer?
  private var reader: AVAssetReader?
  private var output: AVAssetReaderTrackOutput?
  private var pending: CMSampleBuffer?
  private var loopStart: Double = 0
  private var firstPTS: Double = 0
  private let url: URL
  // RTCVideoCapturer's delegate is weak; keep the Objective-C source alive.
  private let source: RTCVideoSource
  private let onFailure: (String) -> Void
  private(set) var sentFrames = 0

  init(source: RTCVideoSource, url: URL, onFailure: @escaping (String) -> Void) {
    self.url = url
    self.source = source
    self.onFailure = onFailure
    super.init(delegate: source)
  }

  func start() {
    queue.async { [weak self] in
      guard let self, self.timer == nil else { return }
      do {
        try self.resetReader()
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in autoreleasepool { self?.tick() } }
        self.timer = timer
        timer.resume()
      } catch { self.onFailure("Could not decode the bundled test clip: \(error.localizedDescription)") }
    }
  }

  func stop() {
    queue.sync {
      timer?.cancel(); timer = nil
      reader?.cancelReading(); reader = nil; output = nil; pending = nil
    }
  }

  private func resetReader() throws {
    reader?.cancelReading()
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
      throw NSError(domain: "DuoDesk", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing video track"])
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw NSError(domain: "DuoDesk", code: 2) }
    reader.add(output)
    guard reader.startReading(), let sample = output.copyNextSampleBuffer() else {
      throw reader.error ?? NSError(domain: "DuoDesk", code: 3)
    }
    self.reader = reader; self.output = output; pending = sample
    firstPTS = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
    loopStart = CACurrentMediaTime()
  }

  private func tick() {
    guard let output, let reader else { return }
    let now = CACurrentMediaTime()
    var latest: CMSampleBuffer?
    // Bound work per tick, including when the device falls far behind.
    for _ in 0..<12 {
      guard let sample = pending else { break }
      let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) - firstPTS
      if pts > now - loopStart { break }
      latest = sample
      pending = output.copyNextSampleBuffer()
    }
    if let latest, let pixel = CMSampleBufferGetImageBuffer(latest) {
      let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixel), rotation: ._0,
                                timeStampNs: Int64(now * 1_000_000_000))
      delegate?.capturer(self, didCapture: frame)
      sentFrames += 1
    }
    if pending == nil {
      if reader.status == .failed {
        timer?.cancel(); timer = nil
        onFailure(reader.error?.localizedDescription ?? "Clip decoding failed")
      } else {
        do { try resetReader() }
        catch { timer?.cancel(); timer = nil; onFailure("Could not loop the test clip") }
      }
    }
  }
}
