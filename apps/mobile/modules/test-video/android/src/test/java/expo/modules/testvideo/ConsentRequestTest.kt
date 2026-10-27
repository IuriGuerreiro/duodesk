package expo.modules.testvideo

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MockPromise : Promise {
  var resolvedValue: Any? = null
  @Volatile
  var resolved: Boolean = false
  @Volatile
  var rejectedCode: String? = null
  @Volatile
  var rejectedMessage: String? = null
  @Volatile
  var rejectedCause: Throwable? = null
  @Volatile
  var rejected: Boolean = false

  private val lock = Any()

  override fun resolve(value: Any?) {
    synchronized(lock) {
      resolved = true
      resolvedValue = value
    }
  }

  override fun reject(code: String?, message: String?, cause: Throwable?) {
    synchronized(lock) {
      rejected = true
      rejectedCode = code
      rejectedMessage = message
      rejectedCause = cause
    }
  }

  override fun reject(exception: CodedException) {
    synchronized(lock) {
      rejected = true
      rejectedCode = exception.code
      rejectedMessage = exception.message
      rejectedCause = exception.cause
    }
  }
}

class ConsentRequestTest {

  @Test
  fun testConsentRequestResolvesExactlyOnce() {
    val promise = MockPromise()
    val request = ConsentRequest(
      id = 1L,
      requestCode = 3001,
      senderGeneration = 0L,
      bitrateMbps = 10,
      shareAudio = true,
      promise = promise
    )

    assertFalse(request.isSettled)
    val resolved = request.resolve()
    assertTrue(resolved)
    assertTrue(request.isSettled)
    assertTrue(promise.resolved)

    // Attempt second settlement via reject
    val rejected = request.reject("ERR_FAILED", "Should not overwrite", null)
    assertFalse(rejected)
    assertFalse(promise.rejected)
  }

  @Test
  fun testConsentRequestRejectsExactlyOnce() {
    val promise = MockPromise()
    val request = ConsentRequest(
      id = 2L,
      requestCode = 3002,
      senderGeneration = 1L,
      bitrateMbps = 15,
      shareAudio = true,
      promise = promise
    )

    val rejected = request.reject("ERR_PERMISSION", "Permission denied", null)
    assertTrue(rejected)
    assertTrue(request.isSettled)
    assertTrue(promise.rejected)
    assertEquals("ERR_PERMISSION", promise.rejectedCode)
    assertEquals("Permission denied", promise.rejectedMessage)

    // Attempt second settlement via resolve
    val resolved = request.resolve()
    assertFalse(resolved)
    assertFalse(promise.resolved)
  }

  @Test
  fun testConcurrentResolveAndRejectThreadSafety() {
    val threadCount = 20
    val iterations = 50

    for (i in 0 until iterations) {
      val promise = MockPromise()
      val request = ConsentRequest(
        id = i.toLong(),
        requestCode = 3000 + i,
        senderGeneration = 0L,
        bitrateMbps = 10,
        shareAudio = true,
        promise = promise
      )

      val startLatch = CountDownLatch(1)
      val doneLatch = CountDownLatch(threadCount)
      val successfulSettlements = AtomicInteger(0)

      for (t in 0 until threadCount) {
        Thread {
          startLatch.await()
          val won = if (t % 2 == 0) {
            request.resolve()
          } else {
            request.reject("ERR_CONCURRENT", "Thread race test", null)
          }
          if (won) {
            successfulSettlements.incrementAndGet()
          }
          doneLatch.countDown()
        }.start()
      }

      startLatch.countDown()
      assertTrue(doneLatch.await(5, TimeUnit.SECONDS))

      assertEquals("Exactly one thread must win the settlement race", 1, successfulSettlements.get())
      assertTrue("Request must be marked settled", request.isSettled)
      assertTrue("Either resolved or rejected, never both", promise.resolved != promise.rejected)
    }
  }

  @Test
  fun testComputeCaptureDimensionsLandscape() {
    val dims = computeCaptureDimensions(1920, 1080)
    assertEquals(1920, dims.width)
    assertEquals(1080, dims.height)
    assertEquals(0, dims.width % 2)
    assertEquals(0, dims.height % 2)
  }

  @Test
  fun testComputeCaptureDimensionsPortraitScaled() {
    val dims = computeCaptureDimensions(1080, 2400)
    // Long side should be scaled down to <= 1920, short side <= 1080, both even
    assertTrue(dims.width <= 1080)
    assertTrue(dims.height <= 1920)
    assertEquals(0, dims.width % 2)
    assertEquals(0, dims.height % 2)
  }

  @Test
  fun testComputeCaptureDimensionsZeroOrNegative() {
    val dims = computeCaptureDimensions(0, -100)
    assertEquals(1080, dims.width)
    assertEquals(1920, dims.height)
  }

  @Test
  fun testConsentRequestCodeRange() {
    val base = VideoSenderManager.BASE_REQUEST_CODE
    assertTrue(VideoSenderManager.isConsentRequestCode(base))
    assertTrue(VideoSenderManager.isConsentRequestCode(base + 500))
    assertTrue(VideoSenderManager.isConsentRequestCode(base + 999))
    assertFalse(VideoSenderManager.isConsentRequestCode(base - 1))
    assertFalse(VideoSenderManager.isConsentRequestCode(base + 1000))
  }

  @Test
  fun testPrepareScreenConsentWithoutActiveSenderRejectsPromise() {
    val promise = MockPromise()
    val request = VideoSenderManager.prepareScreenConsent(12, true, StreamSettings.DEFAULT, promise)
    assertNull(request)
    assertTrue(promise.rejected)
    assertEquals("ERR_STREAM", promise.rejectedCode)
    assertEquals("Connect to the desktop before starting", promise.rejectedMessage)
  }

  @Test
  fun testStopWithoutActiveSenderResolvesPromise() {
    val promise = MockPromise()
    VideoSenderManager.stop(promise)
    assertTrue(promise.resolved)
  }
}
