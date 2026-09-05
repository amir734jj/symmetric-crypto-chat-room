package com.hesamian.symmetriccryptochat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.microsoft.signalr.HubConnection;
import com.microsoft.signalr.HubConnectionBuilder;
import com.microsoft.signalr.HubConnectionState;

public class VoiceCallService extends Service {
    private static final String TAG = "VoiceCallService";
    private static final String STATUS_CHANNEL_ID = "background_calls";
    private static final String INCOMING_CHANNEL_ID = "incoming_calls";
    private static final String ACTION_SET_CALL_ACTIVE = "set_call_active";
    private static final String EXTRA_CALL_ACTIVE = "call_active";
    private static final int STATUS_NOTIFICATION_ID = 1001;
    private static final int INCOMING_NOTIFICATION_ID = 1002;
    private static final long MAX_RECONNECT_DELAY_MILLISECONDS = 60000;
    private static volatile boolean serviceRunning;

    private final Handler reconnectHandler = new Handler(Looper.getMainLooper());
    private HubConnection hubConnection;
    private BackgroundCallSession.Session session;
    private PowerManager.WakeLock wakeLock;
    private boolean callActive;
    private boolean stopping;
    private int reconnectAttempts;

    public static void startListening(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, VoiceCallService.class));
    }

    public static void setCallActive(Context context, boolean active) {
        Intent intent = new Intent(context, VoiceCallService.class)
            .setAction(ACTION_SET_CALL_ACTIVE)
            .putExtra(EXTRA_CALL_ACTIVE, active);
        if (serviceRunning) {
            context.startService(intent);
        } else {
            ContextCompat.startForegroundService(context, intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, VoiceCallService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        createNotificationChannels();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            session = BackgroundCallSession.load(this);
            if (session == null) {
                stopSelf();
                return START_NOT_STICKY;
            }

            if (intent != null && ACTION_SET_CALL_ACTIVE.equals(intent.getAction())) {
                setActiveCallState(intent.getBooleanExtra(EXTRA_CALL_ACTIVE, false));
            } else {
                updateForegroundNotification();
            }
            connect();
            return START_STICKY;
        } catch (RuntimeException exception) {
            Log.e(TAG, "Unable to start background call handling", exception);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        stopping = true;
        reconnectHandler.removeCallbacksAndMessages(null);
        releaseWakeLock();
        cancelIncomingCallNotification();
        if (hubConnection != null) {
            hubConnection.stop().subscribe(
                () -> { },
                error -> Log.w(TAG, "Unable to stop background SignalR connection", error));
        }
        super.onDestroy();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel statusChannel = new NotificationChannel(
            STATUS_CHANNEL_ID,
            "Background call availability",
            NotificationManager.IMPORTANCE_LOW);
        statusChannel.setDescription("Keeps this device available for encrypted voice calls");

        NotificationChannel incomingChannel = new NotificationChannel(
            INCOMING_CHANNEL_ID,
            "Incoming voice calls",
            NotificationManager.IMPORTANCE_HIGH);
        incomingChannel.setDescription("Alerts for incoming encrypted voice calls");

        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        notificationManager.createNotificationChannel(statusChannel);
        notificationManager.createNotificationChannel(incomingChannel);
    }

    private Notification createStatusNotification() {
        return new NotificationCompat.Builder(this, STATUS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_voice_call)
            .setContentTitle(callActive ? "Voice call active" : "Ready for calls")
            .setContentText(callActive
                ? "Tap to return to Symmetric Crypto Chat"
                : "Background call notifications are enabled")
            .setContentIntent(createOpenAppIntent())
            .setCategory(callActive ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .build();
    }

    private PendingIntent createOpenAppIntent() {
        Intent intent = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showIncomingCallNotification(String callerName) {
        Notification notification = new NotificationCompat.Builder(this, INCOMING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_voice_call)
            .setContentTitle(callerName + " is calling")
            .setContentText("Tap to open Symmetric Crypto Chat")
            .setContentIntent(createOpenAppIntent())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build();
        getSystemService(NotificationManager.class).notify(INCOMING_NOTIFICATION_ID, notification);
    }

    private void cancelIncomingCallNotification() {
        getSystemService(NotificationManager.class).cancel(INCOMING_NOTIFICATION_ID);
    }

    private void updateForegroundNotification() {
        Notification notification = createStatusNotification();
        startListenerForegroundOrStop(notification);
    }

    private void startListenerForegroundOrStop(Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    STATUS_NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
            } else {
                startForeground(STATUS_NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException exception) {
            Log.e(TAG, "Unable to keep the background call listener active", exception);
            stopSelf();
        }
    }

    private void setActiveCallState(boolean active) {
        callActive = active;
        updateForegroundNotification();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":active-voice-call");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private synchronized void connect() {
        if (stopping || session == null ||
            (hubConnection != null && hubConnection.getConnectionState() != HubConnectionState.DISCONNECTED)) {
            return;
        }

        if (hubConnection == null) {
            hubConnection = HubConnectionBuilder.create(session.serverUrl).build();
            hubConnection.setKeepAliveInterval(30000);
            hubConnection.setServerTimeout(90000);
            hubConnection.on(
                "VoiceCallReceived",
                (callerConnectionId, callerName) -> showIncomingCallNotification(callerName),
                String.class,
                String.class);
            hubConnection.on(
                "VoiceCallCancelled",
                (callerConnectionId, timedOut) -> cancelIncomingCallNotification(),
                String.class,
                Boolean.class);
            hubConnection.onClosed(error -> scheduleReconnect());
        }

        hubConnection.start().subscribe(
            () -> hubConnection.invoke(
                "RegisterBackground",
                session.channel,
                session.name,
                session.clientInstanceId).subscribe(
                    () -> reconnectAttempts = 0,
                    error -> {
                        Log.w(TAG, "Unable to register background call endpoint", error);
                        hubConnection.stop().subscribe();
                    }),
            error -> {
                Log.w(TAG, "Unable to connect background call endpoint", error);
                scheduleReconnect();
            });
    }

    private void scheduleReconnect() {
        if (stopping || session == null) {
            return;
        }
        long delay = Math.min(1000L << Math.min(reconnectAttempts++, 6), MAX_RECONNECT_DELAY_MILLISECONDS);
        reconnectHandler.removeCallbacksAndMessages(null);
        reconnectHandler.postDelayed(this::connect, delay);
    }
}