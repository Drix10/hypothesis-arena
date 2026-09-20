#!/bin/bash
# Linux deployment only: create the four trading identities (doc 08 sec. 8.2).
# NOT run on dev hosts. After running, execute the isolation test:
#   setpriv --reuid=miroresearch --regid=miroresearch --clear-groups \
#     python3 research-plane/tests/test_isolation.py --tree /srv/mirohedge
set -euo pipefail
for u in mirotrade miroresearch mirojev mirohuman; do
  id "$u" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$u"
done
TREE="${1:-/srv/mirohedge}"
mkdir -p "$TREE"/{journal,features,signals,stage,creds/broker,creds/jev,creds/sources}
chown mirotrade:mirotrade "$TREE"/journal "$TREE"/stage "$TREE"/creds/broker
chown miroresearch:miroresearch "$TREE"/features "$TREE"/signals "$TREE"/creds/sources
chown mirojev:mirojev "$TREE"/creds/jev
chmod 700 "$TREE"/journal "$TREE"/stage "$TREE"/creds/broker "$TREE"/creds/jev "$TREE"/creds/sources
chmod 755 "$TREE"/features "$TREE"/signals
echo "identities ready under $TREE"
