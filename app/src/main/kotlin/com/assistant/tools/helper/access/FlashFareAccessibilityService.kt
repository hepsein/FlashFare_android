package com.assistant.tools.helper.access

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent
import timber.log.Timber

/**
 * Phase 3 squelette : service accessibility minimal.
 *
 * Phase 4 wirera ici : ScreenSignals (filtre local), TreeSerializer (sérialisation),
 * RideEvaluator (POST /ride/evaluate), OverlayManager (rendu du display reçu),
 * RideStateMachine (cycle de vie offer → trip → next).
 */
class FlashFareAccessibilityService : AccessibilityService() {

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
        Timber.i("FlashFare accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.packageName?.toString() != TARGET_PACKAGE) return
        Timber.d(
            "event=%s class=%s — Phase 4 : ScreenSignals + RideEvaluator wiring",
            AccessibilityEvent.eventTypeToString(event.eventType),
            event.className
        )
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        connected = false
        super.onDestroy()
    }

    companion object {
        const val TARGET_PACKAGE = "com.ubercab.driver"

        @Volatile
        var connected: Boolean = false
            private set
    }
}
