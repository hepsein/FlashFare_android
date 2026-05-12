package com.flashfare.capture

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class CaptureService : AccessibilityService() {

    private val sessionId = UUID.randomUUID().toString().take(8)
    private val seq = AtomicInteger(0)
    private val debouncer = Debouncer(DEBOUNCE_MS)

    override fun onServiceConnected() {
        serviceInfo = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            packageNames = arrayOf(TARGET_PACKAGE)
            notificationTimeout = 100L
        }
        connected = true
        Log.i(TAG, "[FFC session=$sessionId] service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (!enabled) return
        if (event.packageName?.toString() != TARGET_PACKAGE) return

        val eventType = AccessibilityEvent.eventTypeToString(event.eventType)
        val windowClass = event.className?.toString()

        debouncer.submit {
            val root = rootInActiveWindow ?: return@submit
            val n = seq.incrementAndGet()
            val meta = TreeSerializer.Meta(
                session = sessionId,
                seq = n,
                ts = System.currentTimeMillis(),
                eventType = eventType,
                windowClass = windowClass
            )
            val payload = TreeSerializer.serialize(meta, root)
            LogChunker.emit(TAG, sessionId, n, payload)
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        connected = false
        super.onDestroy()
    }

    private class Debouncer(private val delayMs: Long) {
        private val handler = Handler(Looper.getMainLooper())
        private var pending: Runnable? = null
        fun submit(action: () -> Unit) {
            pending?.let { handler.removeCallbacks(it) }
            val runnable = Runnable { action() }
            pending = runnable
            handler.postDelayed(runnable, delayMs)
        }
    }

    companion object {
        const val TAG = "FFC_DUMP"
        const val TARGET_PACKAGE = "com.ubercab.driver"
        private const val DEBOUNCE_MS = 500L

        @Volatile var enabled: Boolean = true
        @Volatile var connected: Boolean = false
            private set
    }
}
