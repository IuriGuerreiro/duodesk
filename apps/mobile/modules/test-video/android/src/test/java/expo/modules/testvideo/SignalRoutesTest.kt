package expo.modules.testvideo

import org.junit.Assert.*
import org.junit.Test

class SignalRoutesTest {
  @Test
  fun onlyTheOffererSendsAnOffer() {
    assertTrue(SignalRoutes.canSend(Direction.PhoneToDesktop, Role.Phone, "offer"))
    assertFalse(SignalRoutes.canSend(Direction.PhoneToDesktop, Role.Desktop, "offer"))
    assertTrue(SignalRoutes.canSend(Direction.DesktopToPhone, Role.Desktop, "offer"))
    assertFalse(SignalRoutes.canSend(Direction.DesktopToPhone, Role.Phone, "offer"))
    assertTrue(SignalRoutes.canSend(Direction.DesktopToPhone, Role.Phone, "answer"))
    assertFalse(SignalRoutes.canSend(Direction.PhoneToDesktop, Role.Phone, "answer"))
  }

  @Test
  fun onlyThePhoneSenderCanPause() {
    for (direction in Direction.values()) for (role in Role.values()) {
      assertEquals(direction == Direction.PhoneToDesktop && role == Role.Phone, SignalRoutes.canSend(direction, role, "pause"))
    }
  }

  @Test
  fun handshakeIsOutsideTheTable() {
    for (direction in Direction.values()) for (role in Role.values()) {
      assertFalse(SignalRoutes.canSend(direction, role, "pair"))
      assertFalse(SignalRoutes.canSend(direction, role, "paired"))
    }
  }

  @Test
  fun desktopFieldsFollowTheDirection() {
    assertEquals(setOf("v", "sessionId", "type", "sdp"), SignalRoutes.desktopFields(Direction.DesktopToPhone, "offer"))
    assertEquals(setOf("v", "sessionId", "type"), SignalRoutes.desktopFields(Direction.PhoneToDesktop, "paired"))
    assertThrows(IllegalStateException::class.java) { SignalRoutes.desktopFields(Direction.PhoneToDesktop, "offer") }
    assertThrows(IllegalStateException::class.java) { SignalRoutes.desktopFields(Direction.DesktopToPhone, "answer") }
  }

  @Test
  fun directionsParseFromTheirWireNames() {
    assertEquals(Direction.DesktopToPhone, Direction.parse("desktop-to-phone"))
    assertThrows(IllegalStateException::class.java) { Direction.parse("both") }
  }
}
