package com.hesamian.symmetriccryptochat;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static boolean crashHandlerInstalled;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		if (!crashHandlerInstalled) {
			crashHandlerInstalled = true;
			Thread.UncaughtExceptionHandler previousHandler = Thread.getDefaultUncaughtExceptionHandler();
			Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
				NativeDebugLog.record(getApplicationContext(), "UncaughtException", thread.getName(), error);
				if (previousHandler != null) {
					previousHandler.uncaughtException(thread, error);
				}
			});
		}
		NativeDebugLog.record(this, "MainActivity", "onCreate");
		registerPlugin(VoiceAudioRouterPlugin.class);
		super.onCreate(savedInstanceState);
	}
}
