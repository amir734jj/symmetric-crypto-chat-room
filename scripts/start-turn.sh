#!/bin/sh
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set}"
: "${TURN_EXTERNAL_IP:?TURN_EXTERNAL_IP must be set}"

set -- turnserver \
    --no-cli --fingerprint --use-auth-secret \
    "--static-auth-secret=$TURN_SECRET" \
    "--realm=${TURN_REALM:-chat.coolify.hesamian.com}" \
    "--external-ip=$TURN_EXTERNAL_IP" \
    "--listening-port=${TURN_LISTENING_PORT:-3478}" \
    "--min-port=${TURN_MIN_PORT:-49160}" \
    "--max-port=${TURN_MAX_PORT:-49200}" \
    --log-file=stdout

case "${TURN_TLS_ONLY:-false}" in
    [Tt][Rr][Uu][Ee])
        : "${TURN_TLS_CERT_FILE:?TURN_TLS_CERT_FILE must point to a mounted full-chain PEM certificate}"
        : "${TURN_TLS_KEY_FILE:?TURN_TLS_KEY_FILE must point to a mounted PEM private key}"
        if [ ! -r "$TURN_TLS_CERT_FILE" ] || [ ! -r "$TURN_TLS_KEY_FILE" ]; then
            echo "TURN TLS certificate and private key must be readable" >&2
            exit 1
        fi
        # Retain UDP on the internal listening port for the container health check only.
        set -- "$@" --no-tcp --no-dtls --no-tlsv1 --no-tlsv1_1 \
            "--tls-listening-port=${TURN_TLS_PORT:-443}" \
            "--cert=$TURN_TLS_CERT_FILE" "--pkey=$TURN_TLS_KEY_FILE"
        ;;
    [Ff][Aa][Ll][Ss][Ee])
        set -- "$@" --no-tls --no-dtls
        ;;
    *)
        echo "TURN_TLS_ONLY must be true or false" >&2
        exit 1
        ;;
esac

exec "$@"
