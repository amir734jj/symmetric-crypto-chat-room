package com.hesamian.symmetriccryptochat;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class NativeDebugLog {
    private static final String TAG = "NativeDebugLog";
    private static final String PREFERENCES_NAME = "native_debug_log";
    private static final String ENTRIES_KEY = "entries";
    private static final int MAX_ENTRIES = 200;

    private NativeDebugLog() {
    }

    static synchronized void record(Context context, String source, String message) {
        record(context, source, message, null);
    }

    static synchronized void record(Context context, String source, String message, Throwable error) {
        try {
            SharedPreferences preferences = preferences(context);
            JSONArray entries = readEntries(preferences);
            JSONObject entry = new JSONObject();
            entry.put("timestamp", timestamp());
            entry.put("source", source);
            entry.put("message", message);
            if (error != null) {
                StringWriter stackTrace = new StringWriter();
                error.printStackTrace(new PrintWriter(stackTrace));
                entry.put("stackTrace", stackTrace.toString());
            }
            entries.put(entry);
            while (entries.length() > MAX_ENTRIES) {
                entries.remove(0);
            }
            preferences.edit().putString(ENTRIES_KEY, entries.toString()).commit();
        } catch (Exception exception) {
            Log.e(TAG, "Unable to persist diagnostic entry", exception);
        }
    }

    static synchronized String getReport(Context context) {
        JSONArray entries = readEntries(preferences(context));
        return "Device: " + Build.MANUFACTURER + " " + Build.MODEL + "\n" +
            "Android: " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")\n" +
            "App package: " + context.getPackageName() + "\n\n" +
            format(entries);
    }

    static synchronized void clear(Context context) {
        preferences(context).edit().remove(ENTRIES_KEY).commit();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private static JSONArray readEntries(SharedPreferences preferences) {
        try {
            return new JSONArray(preferences.getString(ENTRIES_KEY, "[]"));
        } catch (Exception exception) {
            return new JSONArray();
        }
    }

    private static String format(JSONArray entries) {
        StringBuilder report = new StringBuilder();
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry == null) {
                continue;
            }
            report.append(entry.optString("timestamp"))
                .append(" [").append(entry.optString("source")).append("] ")
                .append(entry.optString("message")).append('\n');
            String stackTrace = entry.optString("stackTrace");
            if (!stackTrace.isEmpty()) {
                report.append(stackTrace).append('\n');
            }
        }
        return report.toString();
    }

    private static String timestamp() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }
}