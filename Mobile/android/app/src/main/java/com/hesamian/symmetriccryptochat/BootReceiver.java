package com.hesamian.symmetriccryptochat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && BackgroundCallSession.load(context) != null) {
                VoiceCallService.startListening(context);
            }
        } catch (RuntimeException exception) {
            Log.e(TAG, "Unable to restore background call handling after boot", exception);
        }
    }
}