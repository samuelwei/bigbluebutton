#!/bin/sh
# Obtains and renews the certificate for BBB_DOMAIN with the webroot nginx serves on port 80, as
# bbb-install and certbot.timer do, and hands it to haproxy, which reloads through its master
# socket. Until the first certificate is issued, haproxy serves a self-signed one.
set -u
bundle=/etc/letsencrypt/certbundle.pem
live="/etc/letsencrypt/live/$BBB_DOMAIN"
if [ ! -s "$bundle" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$BBB_DOMAIN" \
    -keyout /tmp/key.pem -out /tmp/cert.pem 2>/dev/null
  cat /tmp/cert.pem /tmp/key.pem > "$bundle" && chown 99 "$bundle" && chmod 0600 "$bundle"
fi
# haproxy (UID 99) puts its master socket here
chown 99 /var/lib/haproxy
while :; do
  delay=12h
  certbot certonly --webroot -w /var/www/bigbluebutton-default/assets -d "$BBB_DOMAIN" \
    --email "$ACME_EMAIL" --agree-tos --non-interactive --rsa-key-size 4096 --keep-until-expiring \
    || delay=15m
  if [ -s "$live/privkey.pem" ] && ! cat "$live/fullchain.pem" "$live/privkey.pem" | cmp -s - "$bundle"; then
    cat "$live/fullchain.pem" "$live/privkey.pem" > "$bundle.new"
    chown 99 "$bundle.new" && chmod 0600 "$bundle.new" && mv "$bundle.new" "$bundle"
    python3 -c 'import socket; s = socket.socket(socket.AF_UNIX); s.connect("/var/lib/haproxy/master.sock"); s.sendall(b"reload\n"); print(s.recv(4096).decode())' \
      || echo "haproxy is not running yet; it reads the new certificate when it starts"
  fi
  sleep "$delay"
done
