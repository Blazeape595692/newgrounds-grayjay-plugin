#!/usr/bin/env bash
# Signs NewgroundsScript.js and writes the signature and public key into
# NewgroundsConfig.json. Run it after every change to the script.
# The private key stays outside the repo (default below, or pass a path).
set -euo pipefail
cd "$(dirname "$0")"
KEY="${1:-$HOME/.config/newgrounds-grayjay-plugin/signing-key.pem}"
[ -f "$KEY" ] || { echo "Signing key not found: $KEY" >&2; exit 1; }

SIG=$(openssl dgst -sha512 -sign "$KEY" NewgroundsScript.js | openssl enc -base64 -A)
PUB=$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | openssl enc -base64 -A)

python3 - "$SIG" "$PUB" <<'PY'
import json, sys
sig, pub = sys.argv[1], sys.argv[2]
with open("NewgroundsConfig.json") as f:
    c = json.load(f)
c["scriptSignature"] = sig
c["scriptPublicKey"] = pub
with open("NewgroundsConfig.json", "w") as f:
    f.write(json.dumps(c, indent="\t", ensure_ascii=False) + "\n")
PY
echo "Signed NewgroundsScript.js"
