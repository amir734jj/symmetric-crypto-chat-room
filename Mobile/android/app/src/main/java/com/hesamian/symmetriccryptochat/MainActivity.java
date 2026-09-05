package com.hesamian.symmetriccryptochat;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(VoiceAudioRouterPlugin.class);
		super.onCreate(savedInstanceState);
	}
}
