#!/bin/sh
# coturn entrypoint: locate the Let's Encrypt cert that Caddy issued for
# $DOMAIN (shared read-only at /caddy-data), then launch turnserver with the
# dynamic realm / external-ip / secret / TLS flags.
set -eu

DOMAIN="${DOMAIN:?DOMAIN env required}"
CERT_BASE="/caddy-data/caddy/certificates"

find_cert() {
	find "$CERT_BASE" -type f -name "${DOMAIN}.crt" 2>/dev/null | head -n1
}

# Wait (up to ~3 min) for Caddy to obtain the cert on first boot.
CRT=""
i=0
while [ "$i" -lt 60 ]; do
	CRT="$(find_cert)"
	[ -n "$CRT" ] && break
	echo "coturn: waiting for TLS cert for ${DOMAIN} ... (${i})"
	i=$((i + 1))
	sleep 3
done

TLS_ARGS=""
if [ -n "$CRT" ]; then
	KEY="${CRT%.crt}.key"
	echo "coturn: using TLS cert ${CRT}"
	# Symlink to stable paths (turnserver reads them at startup).
	ln -sf "$CRT" /tls.crt
	ln -sf "$KEY" /tls.key
	TLS_ARGS="--cert=/tls.crt --pkey=/tls.key"
else
	echo "coturn: WARNING no TLS cert found for ${DOMAIN}; starting without turns:// (5349)."
	TLS_ARGS="--no-tls --no-dtls"
fi

# EXTERNAL_IP is optional (DO droplets usually have a directly-assigned public IP).
EXT_ARGS=""
[ -n "${EXTERNAL_IP:-}" ] && EXT_ARGS="--external-ip=${EXTERNAL_IP}"

exec turnserver \
	-c /etc/coturn/turnserver.conf \
	--realm="${DOMAIN}" \
	--server-name="${DOMAIN}" \
	--static-auth-secret="${TURN_SECRET:?TURN_SECRET env required}" \
	${EXT_ARGS} \
	${TLS_ARGS}
