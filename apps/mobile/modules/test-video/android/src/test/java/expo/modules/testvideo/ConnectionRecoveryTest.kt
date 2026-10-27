package expo.modules.testvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ConnectionRecoveryTest {
  private class Clock {
    private data class Task(val at: Long, val action: () -> Unit, var cancelled: Boolean = false)
    private var now = 0L
    private val tasks = mutableListOf<Task>()
    fun schedule(delay: Long, action: () -> Unit): () -> Unit {
      val task = Task(now + delay, action)
      tasks.add(task)
      return { task.cancelled = true }
    }
    fun advance(ms: Long) {
      val end = now + ms
      while (true) {
        val next = tasks.filter { !it.cancelled && it.at <= end }.minByOrNull { it.at } ?: break
        tasks.remove(next); now = next.at; next.action()
      }
      now = end
    }
  }

  @Test fun briefLossKeepsThePeerAndDoesNotRestartCapture() {
    val clock = Clock()
    var attempts = 0
    var exhausted = 0
    val recovery = ConnectionRecovery(clock::schedule, {}, { exhausted++ }, { attempts++ })
    recovery.interrupt()
    clock.advance(2_999)
    recovery.connected()
    clock.advance(30_000)
    assertEquals(0, attempts)
    assertEquals(0, exhausted)
  }

  @Test fun duplicateEventsAndManualRetriesShareTwoAttempts() {
    val clock = Clock()
    var attempts = 0
    var exhausted = 0
    val recovery = ConnectionRecovery(clock::schedule, {}, { exhausted++ }, { attempts++ })
    recovery.interrupt()
    recovery.reconnect()
    recovery.interrupt()
    recovery.reconnect()
    assertEquals(1, attempts)
    clock.advance(8_000)
    recovery.reconnect()
    clock.advance(30_000)
    recovery.reconnect()
    assertEquals(2, attempts)
    assertEquals(1, exhausted)
  }

  @Test fun stopCancelsEveryRecoveryPhase() {
    for (delay in listOf(0L, 3_000L, 11_000L, 13_000L)) {
      val clock = Clock()
      var attempts = 0
      var exhausted = 0
      val recovery = ConnectionRecovery(clock::schedule, {}, { exhausted++ }, { attempts++ })
      recovery.interrupt()
      clock.advance(delay)
      recovery.connected()
      val before = attempts
      clock.advance(60_000)
      recovery.reconnect()
      assertEquals(before, attempts)
      assertEquals(0, exhausted)
    }
  }

  @Test fun receiverHasADeadlineAndCannotOffer() {
    val clock = Clock()
    var exhausted = 0
    val recovery = ConnectionRecovery(clock::schedule, {}, { exhausted++ })
    recovery.interrupt()
    assertEquals(false, recovery.fields()["canReconnect"])
    clock.advance(24_999)
    assertEquals(0, exhausted)
    clock.advance(1)
    assertEquals(1, exhausted)
    assertFalse(recovery.active)
    recovery.interrupt()
    clock.advance(25_000)
    assertEquals(2, exhausted)
  }
}
