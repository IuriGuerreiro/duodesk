package expo.modules.testvideo

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

/** Only PAKE public messages and the encrypted invitation use this socket. */
internal class PairingTransport {
  private val lock = Any()
  private var socket: Socket? = null
  private var generation = 0L
  fun ticket(): Long = synchronized(lock) { generation }
  fun close() {
    val old = synchronized(lock) { generation++; socket.also { socket = null } }
    old?.close()
  }
  fun request(address: String, message: String, fresh: Boolean, ticket: Long): String {
    require(message.toByteArray(Charsets.UTF_8).size <= 8191 && !message.contains('\n')) { "Invalid pairing message" }
    if (fresh) {
      val old = synchronized(lock) {
        require(ticket == generation) { "Pairing cancelled" }
        socket.also { socket = null }
      }
      old?.close()
      require(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}:[0-9]{1,5}").matches(address)) { "Invalid desktop address" }
      val parts = address.split(':')
      require(parts.size == 2)
      val octets = parts[0].split('.').map { it.toInt() }
      require(octets.size == 4 && octets.all { it in 0..255 })
      require(octets[0] == 10 || octets[0] == 172 && octets[1] in 16..31 || octets[0] == 192 && octets[1] == 168 || octets[0] == 169 && octets[1] == 254 || octets[0] == 100 && octets[1] in 64..127) { "Use a private LAN address" }
      val port = parts[1].toInt()
      require(port in 1..65535 && address == octets.joinToString(".") + ":" + port)
      val next = Socket()
      synchronized(lock) {
        if (ticket != generation) { next.close(); error("Pairing cancelled") }
        socket = next
      }
      next.soTimeout = 5000
      next.connect(InetSocketAddress(InetAddress.getByAddress(octets.map { it.toByte() }.toByteArray()), port), 5000)
    }
    val active = synchronized(lock) {
      require(ticket == generation) { "Pairing cancelled" }
      requireNotNull(socket) { "Pairing closed" }
    }
    try {
      active.getOutputStream().write((message + "\n").toByteArray(Charsets.UTF_8))
      val deadline = System.nanoTime() + 5_000_000_000L
      val output = java.io.ByteArrayOutputStream()
      val input = active.getInputStream()
      while (output.size() < 8192) {
        val remaining = (deadline - System.nanoTime()) / 1_000_000L
        require(remaining > 0) { "Pairing read timed out" }
        active.soTimeout = remaining.coerceAtMost(5000L).toInt().coerceAtLeast(1)
        val byte = input.read()
        require(byte >= 0) { "Desktop closed pairing" }
        if (byte == 10) return output.toString("UTF-8")
        output.write(byte)
      }
      error("Pairing response too large")
    } catch (error: Exception) { close(); throw error }
  }
}
