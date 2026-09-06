package com.hesamian.symmetriccryptochat;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "VoiceAudioRouter",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class VoiceAudioRouterPlugin extends Plugin implements SensorEventListener {
    private static final String TAG = "VoiceAudioRouter";
    private AudioManager audioManager;
    private SensorManager sensorManager;
    private Sensor proximitySensor;
    private String routingMode = "auto";
    private int originalAudioMode = AudioManager.MODE_NORMAL;
    private boolean routingActive;

    @Override
    public void load() {
        Context context = getContext();
        audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        sensorManager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
        proximitySensor = sensorManager == null
            ? null
            : sensorManager.getDefaultSensor(Sensor.TYPE_PROXIMITY);
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", audioManager != null);
        result.put("hasEarpiece", hasOutputType(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE));
        result.put("hasSpeaker", hasOutputType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER));
        result.put("hasProximitySensor", proximitySensor != null);
        call.resolve(result);
    }

    @PluginMethod
    public void getDebugLog(PluginCall call) {
        JSObject result = new JSObject();
        result.put("report", NativeDebugLog.getReport(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void clearDebugLog(PluginCall call) {
        NativeDebugLog.clear(getContext());
        NativeDebugLog.record(getContext(), "Diagnostics", "Native log cleared");
        call.resolve();
    }

    @PluginMethod
    public void setMode(PluginCall call) {
        String selectedMode = call.getString("mode", "auto");
        if (!selectedMode.equals("auto") && !selectedMode.equals("earpiece") && !selectedMode.equals("speaker")) {
            call.reject("Unknown audio output mode");
            return;
        }

        try {
            beginRouting();
            stopProximityRouting();
            routingMode = selectedMode;

            if (selectedMode.equals("speaker")) {
                routeTo(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
            } else if (selectedMode.equals("earpiece")) {
                routeTo(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
            } else {
                clearForcedRoute();
                startProximityRouting();
            }

            call.resolve();
        } catch (Exception exception) {
            call.reject(exception.getMessage(), null, exception);
        }
    }

    @PluginMethod
    public void reset(PluginCall call) {
        try {
            resetRouting();
        } catch (RuntimeException exception) {
            Log.w(TAG, "Unable to reset native audio routing", exception);
        }
        call.resolve();
    }

    @PluginMethod
    public void startCall(PluginCall call) {
        NativeDebugLog.record(getContext(), "VoiceAudioRouter", "startCall requested");
        try {
            VoiceCallService.setCallActive(getContext(), true);
        } catch (Exception exception) {
            Log.w(TAG, "Unable to keep the voice call active in the background", exception);
            NativeDebugLog.record(getContext(), "VoiceAudioRouter", "startCall failed", exception);
        }
        call.resolve();
    }

    @PluginMethod
    public void stopCall(PluginCall call) {
        try {
            VoiceCallService.setCallActive(getContext(), false);
        } catch (Exception exception) {
            Log.w(TAG, "Unable to update the background call state", exception);
        }
        call.resolve();
    }

    @PluginMethod
    public void registerBackground(PluginCall call) {
        String serverUrl = call.getString("serverUrl");
        String channel = call.getString("channel");
        String name = call.getString("name");
        String password = call.getString("password");
        String clientInstanceId = call.getString("clientInstanceId");
        if (serverUrl == null || channel == null || name == null || password == null || clientInstanceId == null) {
            call.reject("Background call registration is incomplete");
            return;
        }

        try {
            BackgroundCallSession.save(
                getContext(),
                new BackgroundCallSession.Session(serverUrl, channel, name, password, clientInstanceId));
        } catch (Exception exception) {
            call.reject("Unable to securely store the chat session", null, exception);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        finishBackgroundRegistration(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        finishBackgroundRegistration(call);
    }

    @PluginMethod
    public void restoreBackgroundSession(PluginCall call) {
        BackgroundCallSession.Session session = BackgroundCallSession.load(getContext());
        if (session == null) {
            call.resolve();
            return;
        }

        JSObject result = new JSObject();
        result.put("channel", session.channel);
        result.put("name", session.name);
        result.put("password", session.password);
        call.resolve(result);
    }

    @PluginMethod
    public void unregisterBackground(PluginCall call) {
        BackgroundCallSession.clear(getContext());
        VoiceCallService.stop(getContext());
        call.resolve();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        try {
            Sensor activeSensor = proximitySensor;
            if (!routingMode.equals("auto") || activeSensor == null ||
                event.values.length == 0 || hasExternalCommunicationDevice()) {
                return;
            }

            boolean isNear = event.values[0] < activeSensor.getMaximumRange();
            routeTo(isNear
                ? AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                : AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
        } catch (RuntimeException exception) {
            Log.w(TAG, "Unable to apply proximity audio route", exception);
            stopProximityRouting();
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    @Override
    protected void handleOnDestroy() {
        try {
            resetRouting();
        } catch (RuntimeException exception) {
            Log.w(TAG, "Unable to reset audio routing while closing the app", exception);
        }
    }

    private void beginRouting() {
        if (!routingActive) {
            originalAudioMode = audioManager.getMode();
            routingActive = true;
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
    }

    private void startProximityRouting() {
        if (sensorManager != null && proximitySensor != null) {
            sensorManager.registerListener(this, proximitySensor, SensorManager.SENSOR_DELAY_NORMAL);
        }
    }

    private void stopProximityRouting() {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
    }

    private void routeTo(int deviceType) {
        if (!hasOutputType(deviceType)) {
            throw new IllegalStateException(deviceType == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                ? "This device does not have an earpiece"
                : "This device does not have a speaker");
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                if (device.getType() == deviceType) {
                    if (!audioManager.setCommunicationDevice(device)) {
                        throw new IllegalStateException("Android rejected the requested audio route");
                    }
                    return;
                }
            }
            throw new IllegalStateException("The requested audio route is unavailable");
        }

        audioManager.setSpeakerphoneOn(deviceType == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
    }

    private void clearForcedRoute() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice();
        } else {
            audioManager.setSpeakerphoneOn(false);
        }
    }

    private boolean hasOutputType(int deviceType) {
        if (audioManager == null) {
            return false;
        }
        for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (device.getType() == deviceType) {
                return true;
            }
        }
        return false;
    }

    private boolean hasExternalCommunicationDevice() {
        if (audioManager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo device = audioManager.getCommunicationDevice();
            return device != null && isExternalDevice(device.getType());
        }
        return audioManager.isBluetoothScoOn() || audioManager.isBluetoothA2dpOn() || audioManager.isWiredHeadsetOn();
    }

    private boolean isExternalDevice(int deviceType) {
        return deviceType == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || deviceType == AudioDeviceInfo.TYPE_BLE_HEADSET
            || deviceType == AudioDeviceInfo.TYPE_BLE_SPEAKER
            || deviceType == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            || deviceType == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || deviceType == AudioDeviceInfo.TYPE_USB_HEADSET;
    }

    private void resetRouting() {
        stopProximityRouting();
        if (audioManager != null && routingActive) {
            clearForcedRoute();
            audioManager.setMode(originalAudioMode);
        }
        routingMode = "auto";
        routingActive = false;
    }

    private void finishBackgroundRegistration(PluginCall call) {
        try {
            VoiceCallService.startListening(getContext());
            requestBatteryOptimizationExemption();
            JSObject result = new JSObject();
            result.put("notificationsEnabled", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                getPermissionState("notifications") == PermissionState.GRANTED);
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Unable to start background call handling", null, exception);
        }
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return;
        }
        PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (powerManager.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
            return;
        }

        Intent intent = new Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(intent);
    }
}