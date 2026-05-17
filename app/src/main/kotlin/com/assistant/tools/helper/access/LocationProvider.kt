package com.assistant.tools.helper.access

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import androidx.core.content.ContextCompat

object LocationProvider {

    data class Snapshot(
        val lat: Double,
        val lng: Double,
        val accuracyM: Float,
        val provider: String,
        val capturedAt: Long
    )

    fun lastKnown(context: Context): Snapshot? {
        if (!hasPermission(context)) return null
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return null
        var best: Location? = null
        for (provider in lm.allProviders) {
            try {
                @Suppress("MissingPermission")
                val loc = lm.getLastKnownLocation(provider) ?: continue
                if (best == null || loc.time > best.time) best = loc
            } catch (_: SecurityException) {
                // permission revoked between check and use
            }
        }
        return best?.let {
            Snapshot(
                lat = it.latitude,
                lng = it.longitude,
                accuracyM = it.accuracy,
                provider = it.provider ?: "unknown",
                capturedAt = it.time
            )
        }
    }

    fun hasPermission(context: Context): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        )
        val coarse = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION
        )
        return fine == PackageManager.PERMISSION_GRANTED ||
            coarse == PackageManager.PERMISSION_GRANTED
    }
}
