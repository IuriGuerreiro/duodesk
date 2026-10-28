package expo.modules.testvideo

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.util.concurrent.Executors

/**
 * Browses `_duodesk._tcp` with the platform DNS-SD stack (no subnet scanning).
 * Records are untrusted; JS validates them and pairing still needs the desktop code.
 */
internal class NearbyBrowser(context: Context, private val serviceType: String = SERVICE_TYPE, private val emit: (Map<String, Any?>) -> Unit) {
  private val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
  private val executor = Executors.newSingleThreadExecutor()
  private val lock = Any()
  private var discovery: NsdManager.DiscoveryListener? = null
  private val infoCallbacks = mutableMapOf<String, NsdManager.ServiceInfoCallback>()
  private val pending = ArrayDeque<NsdServiceInfo>()
  private var resolving = false

  val supported get() = nsd != null

  fun start() {
    val manager = nsd ?: return emit(mapOf("type" to "state", "state" to "unsupported"))
    stop()
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) = emit(mapOf("type" to "state", "state" to "searching"))
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        synchronized(lock) { if (discovery === this) discovery = null }
        emit(mapOf("type" to "state", "state" to "error", "code" to errorCode))
      }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onServiceFound(info: NsdServiceInfo) {
        if (!current(this) || !info.serviceName.startsWith("DuoDesk-")) return
        resolve(info)
      }
      override fun onServiceLost(info: NsdServiceInfo) {
        if (!current(this)) return
        unwatch(info.serviceName)
        emit(mapOf("type" to "lost", "instance" to info.serviceName))
      }
    }
    synchronized(lock) { discovery = listener }
    try {
      manager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (error: Exception) {
      synchronized(lock) { discovery = null }
      emit(mapOf("type" to "state", "state" to "error", "message" to error.message))
    }
  }

  fun stop() {
    val manager = nsd ?: return
    val old = synchronized(lock) {
      val callbacks = infoCallbacks.values.toList()
      infoCallbacks.clear(); pending.clear(); resolving = false
      Pair(discovery.also { discovery = null }, callbacks)
    }
    old.first?.let { runCatching { manager.stopServiceDiscovery(it) } }
    if (Build.VERSION.SDK_INT >= 34) old.second.forEach { runCatching { manager.unregisterServiceInfoCallback(it) } }
  }

  private fun current(listener: NsdManager.DiscoveryListener) = synchronized(lock) { discovery === listener }

  private fun found(info: NsdServiceInfo, hosts: List<String>) {
    // NsdServiceInfo.attributes may reuse one Entry object while iterating, so read by key
    // instead of collecting entries.
    val attributes = info.attributes.orEmpty()
    val txt = attributes.keys.toList()
      .filter { it.length <= 16 }
      .take(8)
      .mapNotNull { key ->
        val value = attributes[key]
        if ((value?.size ?: 0) > 128) null else key to (value?.toString(Charsets.UTF_8) ?: "")
      }
      .toMap()
    emit(mapOf("type" to "found", "instance" to info.serviceName, "hosts" to hosts, "port" to info.port, "txt" to txt))
  }

  private fun resolve(info: NsdServiceInfo) {
    val manager = nsd ?: return
    if (Build.VERSION.SDK_INT >= 34) {
      if (synchronized(lock) { infoCallbacks.size >= 16 && !infoCallbacks.containsKey(info.serviceName) }) return
      // Keeps receiving address/port/TXT updates (for example after a network change) until lost.
      val callback = object : NsdManager.ServiceInfoCallback {
        override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {}
        override fun onServiceUpdated(updated: NsdServiceInfo) {
          if (synchronized(lock) { infoCallbacks[info.serviceName] !== this }) return
          found(updated, updated.hostAddresses.filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress })
        }
        override fun onServiceLost() {
          if (synchronized(lock) { infoCallbacks[info.serviceName] !== this }) return
          emit(mapOf("type" to "lost", "instance" to info.serviceName))
        }
        override fun onServiceInfoCallbackUnregistered() {}
      }
      val previous = synchronized(lock) { infoCallbacks.put(info.serviceName, callback) }
      previous?.let { runCatching { manager.unregisterServiceInfoCallback(it) } }
      runCatching { manager.registerServiceInfoCallback(info, executor, callback) }
    } else {
      // Older NsdManager allows one resolve at a time; queue them.
      synchronized(lock) { if (pending.size >= 16 || pending.any { it.serviceName == info.serviceName }) return; pending.addLast(info) }
      next()
    }
  }

  @Suppress("DEPRECATION")
  private fun next() {
    val manager = nsd ?: return
    val info = synchronized(lock) {
      if (resolving || discovery == null) return
      pending.removeFirstOrNull()?.also { resolving = true }
    } ?: return
    manager.resolveService(info, object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = done()
      override fun onServiceResolved(resolved: NsdServiceInfo) {
        val host = resolved.host
        if (synchronized(lock) { discovery != null } && host is Inet4Address) found(resolved, listOfNotNull(host.hostAddress))
        done()
      }
      private fun done() { synchronized(lock) { resolving = false }; next() }
    })
  }

  private fun unwatch(name: String) {
    val callback = synchronized(lock) { infoCallbacks.remove(name) } ?: return
    if (Build.VERSION.SDK_INT >= 34) runCatching { nsd?.unregisterServiceInfoCallback(callback) }
  }

  fun destroy() {
    stop()
    executor.shutdownNow()
  }

  companion object {
    const val SERVICE_TYPE = "_duodesk._tcp"
  }
}
