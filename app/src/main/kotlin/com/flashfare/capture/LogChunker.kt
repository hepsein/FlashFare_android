package com.flashfare.capture

import android.util.Log

object LogChunker {

    private const val CHUNK_SIZE = 3500

    fun emit(tag: String, session: String, seq: Int, payload: String) {
        val total = ((payload.length + CHUNK_SIZE - 1) / CHUNK_SIZE).coerceAtLeast(1)
        var index = 0
        var chunk = 1
        while (index < payload.length) {
            val end = (index + CHUNK_SIZE).coerceAtMost(payload.length)
            Log.i(
                tag,
                "[FFC session=$session seq=$seq chunk=$chunk/$total]" +
                    payload.substring(index, end)
            )
            index = end
            chunk++
        }
        Log.i(tag, "[FFC session=$session seq=$seq END]")
    }
}
