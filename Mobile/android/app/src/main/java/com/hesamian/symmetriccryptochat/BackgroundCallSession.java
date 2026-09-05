package com.hesamian.symmetriccryptochat;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class BackgroundCallSession {
    private static final String PREFERENCES_NAME = "background_call_session";
    private static final String ENCRYPTED_SESSION_KEY = "encrypted_session";
    private static final String INITIALIZATION_VECTOR_KEY = "initialization_vector";
    private static final String KEY_ALIAS = "symmetric_crypto_chat_session";

    private BackgroundCallSession() {
    }

    static void save(Context context, Session session) throws Exception {
        JSONObject json = new JSONObject();
        json.put("serverUrl", session.serverUrl);
        json.put("channel", session.channel);
        json.put("name", session.name);
        json.put("password", session.password);
        json.put("clientInstanceId", session.clientInstanceId);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));

        preferences(context).edit()
            .putString(ENCRYPTED_SESSION_KEY, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(INITIALIZATION_VECTOR_KEY, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .apply();
    }

    static Session load(Context context) {
        SharedPreferences preferences = preferences(context);
        String encryptedSession = preferences.getString(ENCRYPTED_SESSION_KEY, null);
        String initializationVector = preferences.getString(INITIALIZATION_VECTOR_KEY, null);
        if (encryptedSession == null || initializationVector == null) {
            return null;
        }

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                new GCMParameterSpec(128, Base64.decode(initializationVector, Base64.NO_WRAP)));
            String value = new String(
                cipher.doFinal(Base64.decode(encryptedSession, Base64.NO_WRAP)),
                StandardCharsets.UTF_8);
            JSONObject json = new JSONObject(value);
            return new Session(
                json.getString("serverUrl"),
                json.getString("channel"),
                json.getString("name"),
                json.getString("password"),
                json.getString("clientInstanceId"));
        } catch (Exception exception) {
            clear(context);
            return null;
        }
    }

    static void clear(Context context) {
        preferences(context).edit().clear().apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }

        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        keyGenerator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return keyGenerator.generateKey();
    }

    static final class Session {
        final String serverUrl;
        final String channel;
        final String name;
        final String password;
        final String clientInstanceId;

        Session(String serverUrl, String channel, String name, String password, String clientInstanceId) {
            this.serverUrl = serverUrl;
            this.channel = channel;
            this.name = name;
            this.password = password;
            this.clientInstanceId = clientInstanceId;
        }
    }
}