package com.hesamian.symmetriccryptochat;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

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

		View debugButton = findViewById(R.id.native_debug_button);
		if (debugButton != null) {
			debugButton.setOnClickListener(view -> showDebugReport());
		}
	}

	@Override
	protected void onResume() {
		super.onResume();
		NativeDebugLog.record(this, "MainActivity", "onResume");
	}

	@Override
	protected void onPause() {
		NativeDebugLog.record(this, "MainActivity", "onPause");
		super.onPause();
	}

	@Override
	protected void onDestroy() {
		NativeDebugLog.record(this, "MainActivity", "onDestroy");
		super.onDestroy();
	}

	private void showDebugReport() {
		String report = NativeDebugLog.getReport(this);
		TextView reportView = new TextView(this);
		reportView.setPadding(32, 24, 32, 24);
		reportView.setText(report.isEmpty() ? "No native diagnostic entries." : report);
		reportView.setTextIsSelectable(true);
		reportView.setMovementMethod(new ScrollingMovementMethod());

		AlertDialog dialog = new AlertDialog.Builder(this)
			.setTitle("App diagnostics")
			.setView(reportView)
			.setPositiveButton("Copy", null)
			.setNeutralButton("Clear", null)
			.setNegativeButton("Close", null)
			.create();
		dialog.setOnShowListener(ignored -> {
			dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
				ClipboardManager clipboard =
					(ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
				if (clipboard != null) {
					clipboard.setPrimaryClip(ClipData.newPlainText("App diagnostics", reportView.getText()));
					Toast.makeText(this, "Diagnostics copied", Toast.LENGTH_SHORT).show();
				}
			});
			dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> {
				NativeDebugLog.clear(this);
				NativeDebugLog.record(this, "Diagnostics", "Native log cleared");
				reportView.setText(NativeDebugLog.getReport(this));
			});
		});
		dialog.show();
	}
}
