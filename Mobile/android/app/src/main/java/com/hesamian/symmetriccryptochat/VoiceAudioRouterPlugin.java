package com.hesamian.symmetriccryptochat;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "VoiceAudioRouter")
public class VoiceAudioRouterPlugin extends Plugin implements SensorEventListener {
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
        proximitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_PROXIMITY);
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
        resetRouting();
        call.resolve();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (!routingMode.equals("auto") || hasExternalCommunicationDevice()) {
            return;
        }

        boolean isNear = event.values[0] < proximitySensor.getMaximumRange();
        try {
            routeTo(isNear
                ? AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                : AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
        } catch (IllegalStateException exception) {
            android.util.Log.w("VoiceAudioRouter", "Unable to apply proximity audio route", exception);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    @Override
    protected void handleOnDestroy() {
        resetRouting();
    }

    private void beginRouting() {
        if (!routingActive) {
            originalAudioMode = audioManager.getMode();
            routingActive = true;
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
    }

    private void startProximityRouting() {
        if (proximitySensor != null) {
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
}