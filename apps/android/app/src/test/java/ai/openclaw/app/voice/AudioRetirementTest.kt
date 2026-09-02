package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioRetirementTest {
  @Test
  fun cancelledClearNeverAuthorizesAnotherMicrophoneEvenAfterRepeatedStop() =
    runTest {
      val owner = AudioRetirement(this)
      val clear = CompletableDeferred<Unit>()
      owner.retire(cleanup = clear)
      clear.cancel()
      owner.retire()

      val failure = runCatching { owner.await() }.exceptionOrNull()
      assertTrue(failure is IllegalStateException)
      assertTrue(failure?.message.orEmpty().contains("Restart the app"))
      assertTrue(owner.pending)
    }
}
