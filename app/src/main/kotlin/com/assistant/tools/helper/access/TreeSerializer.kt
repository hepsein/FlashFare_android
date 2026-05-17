package com.assistant.tools.helper.access

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

object TreeSerializer {

    const val SCHEMA_VERSION = 1

    data class Meta(
        val session: String,
        val seq: Int,
        val ts: Long,
        val eventType: String,
        val windowClass: String?,
        val location: LocationProvider.Snapshot?
    )

    fun serialize(meta: Meta, root: AccessibilityNodeInfo): String {
        val nodes = JSONArray()
        val queue: ArrayDeque<Pair<AccessibilityNodeInfo, Int>> = ArrayDeque()
        queue.add(root to -1)
        var nextId = 0
        val rect = Rect()

        while (queue.isNotEmpty()) {
            val (node, parentId) = queue.removeFirst()
            val id = nextId++
            node.getBoundsInScreen(rect)

            val bounds = JSONArray().apply {
                put(rect.left); put(rect.top); put(rect.right); put(rect.bottom)
            }

            val obj = JSONObject().apply {
                put("id", id)
                put("parent", parentId)
                put("class", node.className?.toString())
                put("vid", node.viewIdResourceName)
                put("text", node.text?.toString())
                put("desc", node.contentDescription?.toString())
                put("bounds", bounds)
            }
            nodes.put(obj)

            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                queue.add(child to id)
            }
        }

        val locationJson = meta.location?.let { loc ->
            JSONObject().apply {
                put("lat", loc.lat)
                put("lng", loc.lng)
                put("accuracy_m", loc.accuracyM.toDouble())
                put("provider", loc.provider)
                put("captured_at", loc.capturedAt)
            }
        }

        val metaJson = JSONObject().apply {
            put("schema_version", SCHEMA_VERSION)
            put("session", meta.session)
            put("seq", meta.seq)
            put("ts", meta.ts)
            put("event_type", meta.eventType)
            put("window_class", meta.windowClass)
            put("location", locationJson)
        }

        return JSONObject().apply {
            put("meta", metaJson)
            put("nodes", nodes)
        }.toString()
    }
}
