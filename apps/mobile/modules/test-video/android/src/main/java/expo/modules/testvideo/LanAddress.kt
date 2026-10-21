package expo.modules.testvideo

import java.net.InetAddress
import java.net.InetSocketAddress

internal object LanAddress {
  fun parse(address: String): InetSocketAddress {
    require(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}:[0-9]{1,5}").matches(address)) { "Use the desktop's local IPv4 address and port." }
    val parts = address.split(':')
    val octets = parts[0].split('.').map { it.toInt() }
    val port = parts[1].toInt()
    require(octets.all { it in 0..255 } && port in 1..65535 && address == octets.joinToString(".") + ":" + port) { "Invalid desktop address" }
    require(octets[0] == 10 || octets[0] == 172 && octets[1] in 16..31 || octets[0] == 192 && octets[1] == 168 || octets[0] == 169 && octets[1] == 254) { "Use a private LAN address" }
    return InetSocketAddress(InetAddress.getByAddress(octets.map { it.toByte() }.toByteArray()), port)
  }
}
