package com.mihir.taskmanager;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Offline queue for location fixes. Every fix is written here first and only deleted once the
 * server has answered for it, so nothing is lost when the phone has no signal on a site — the
 * queue is uploaded (oldest first) as soon as there is a connection. Each row keeps the upload
 * token of the session it was recorded in, so fixes from an earlier session are still uploaded
 * to THAT session even after a new one has started.
 */
class PointStore extends SQLiteOpenHelper {
    private static final int MAX_ROWS = 20000; // ~5 days of continuous tracking; oldest dropped beyond that

    PointStore(Context c) { super(c, "location_queue.db", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE points (id TEXT PRIMARY KEY, token TEXT NOT NULL, url TEXT NOT NULL, t INTEGER NOT NULL, json TEXT NOT NULL)");
        db.execSQL("CREATE INDEX idx_points_t ON points (t)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldV, int newV) { /* v1 only */ }

    synchronized void add(String id, String token, String url, long t, JSONObject json) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues v = new ContentValues();
        v.put("id", id); v.put("token", token); v.put("url", url); v.put("t", t); v.put("json", json.toString());
        db.insertWithOnConflict("points", null, v, SQLiteDatabase.CONFLICT_IGNORE);
        long n = count();
        if (n > MAX_ROWS) db.execSQL("DELETE FROM points WHERE id IN (SELECT id FROM points ORDER BY t LIMIT " + (n - MAX_ROWS) + ")");
    }

    synchronized long count() {
        Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM points", null);
        try { return c.moveToFirst() ? c.getLong(0) : 0; } finally { c.close(); }
    }

    /** The oldest batch that belongs to one token (= one work session). */
    static class Batch { String token; String url; List<String> ids = new ArrayList<String>(); JSONArray points = new JSONArray(); }

    synchronized Batch nextBatch(int max) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor first = db.rawQuery("SELECT token, url FROM points ORDER BY t LIMIT 1", null);
        Batch b = null;
        try {
            if (!first.moveToFirst()) return null;
            b = new Batch(); b.token = first.getString(0); b.url = first.getString(1);
        } finally { first.close(); }
        Cursor c = db.rawQuery("SELECT id, json FROM points WHERE token = ? ORDER BY t LIMIT " + max, new String[]{ b.token });
        try {
            while (c.moveToNext()) {
                b.ids.add(c.getString(0));
                try { b.points.put(new JSONObject(c.getString(1))); } catch (Exception e) { /* corrupt row: dropped with the batch */ }
            }
        } finally { c.close(); }
        return b;
    }

    synchronized void delete(List<String> ids) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try { for (String id : ids) db.delete("points", "id = ?", new String[]{ id }); db.setTransactionSuccessful(); }
        finally { db.endTransaction(); }
    }

    synchronized void deleteToken(String token) { getWritableDatabase().delete("points", "token = ?", new String[]{ token }); }
}
