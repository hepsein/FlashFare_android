package com.flashfare.capture

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import com.flashfare.capture.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.toggle.isChecked = CaptureService.enabled
        binding.toggle.setOnCheckedChangeListener { _, checked ->
            CaptureService.enabled = checked
        }

        binding.openSettings.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
    }

    override fun onResume() {
        super.onResume()
        binding.status.text = if (isCaptureServiceEnabled()) {
            "Service actif : oui"
        } else {
            "Service actif : non"
        }
    }

    private fun isCaptureServiceEnabled(): Boolean {
        val expected = ComponentName(this, CaptureService::class.java).flattenToString()
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabledServices.split(':').any { it.equals(expected, ignoreCase = true) }
    }
}
