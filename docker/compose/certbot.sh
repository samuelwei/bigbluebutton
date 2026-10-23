#!/bin/sh
# Builds the TLS certificate for haproxy as certbundle.pem (fullchain + private key):
#   1. If /certs/fullchain.pem and /certs/privkey.pem are present, use those and keep the
#      bundle in sync when they change.
#   2. Else if ACME_EMAIL is set, obtain and renew with Let's Encrypt (webroot on port 80).
#   3. Until a certificate from (1) or (2) is available, serve a self-signed one for
#      BBB_DOMAIN. haproxy reloads through its master socket when the bundle changes.
set -u
bundle=/etc/letsencrypt/certbundle.pem
live="/etc/letsencrypt/live/$BBB_DOMAIN"
provided_cert=/certs/fullchain.pem
provided_key=/certs/privkey.pem

write_bundle() {
  cat "$1" "$2" > "$bundle.new"
  chown 99 "$bundle.new" && chmod 0600 "$bundle.new" && mv "$bundle.new" "$bundle"
}

reload_haproxy() {
  python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("/var/lib/haproxy/master.sock"); s.sendall(b"reload\n"); print(s.recv(4096).decode())' \
    || echo "haproxy is not running yet; it reads the new certificate when it starts"
}

# haproxy (UID 99) puts its master socket here
chown 99 /var/lib/haproxy

# Own certificate: prefer files mounted at /certs over Let's Encrypt
if [ -s "$provided_cert" ] && [ -s "$provided_key" ]; then
  echo "Using certificate from $provided_cert"
  while :; do
    if [ ! -s "$bundle" ] || ! cat "$provided_cert" "$provided_key" | cmp -s - "$bundle"; then
      write_bundle "$provided_cert" "$provided_key"
      reload_haproxy
    fi
    sleep 1h
  done
fi

# Self-signed until Let's Encrypt issues one (or forever when ACME_EMAIL is unset)
if [ ! -s "$bundle" ]; then
  echo "Generating a self-signed certificate for $BBB_DOMAIN"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$BBB_DOMAIN" \
    -keyout /tmp/key.pem -out /tmp/cert.pem 2>/dev/null
  write_bundle /tmp/cert.pem /tmp/key.pem
fi

if [ -z "${ACME_EMAIL:-}" ]; then
  echo "ACME_EMAIL unset; serving the self-signed certificate for $BBB_DOMAIN"
  while :; do sleep 12h; done
fi

while :; do
  delay=12h
  certbot certonly --webroot -w /var/www/bigbluebutton-default/assets -d "$BBB_DOMAIN" \
    --email "$ACME_EMAIL" --agree-tos --non-interactive --rsa-key-size 4096 --keep-until-expiring \
    || delay=15m
  if [ -s "$live/privkey.pem" ] && ! cat "$live/fullchain.pem" "$live/privkey.pem" | cmp -s - "$bundle"; then
    write_bundle "$live/fullchain.pem" "$live/privkey.pem"
    reload_haproxy
  fi
  sleep "$delay"
done
