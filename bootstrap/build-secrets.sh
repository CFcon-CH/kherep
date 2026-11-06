#!/usr/bin/env bash
# Build or rotate an externally configured encrypted bundle from live files.
# Run on a box that HAS the live secrets (WIN/MAC), NOT a fresh pod. Requires: sops, age.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/profile.sh"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CREDENTIALS_ROOT="$(kherep_env CREDENTIALS_ROOT "$(kherep_default_credentials_root)")"
AGE_KEY="${SOPS_AGE_KEY_FILE:-}"
SECRETS_BUNDLE="${KHEREP_SECRETS_BUNDLE:-}"
kherep_validate_shell_path CLAUDE_HOME "$CLAUDE_HOME" || exit $?
kherep_validate_shell_path KHEREP_CREDENTIALS_ROOT "$CREDENTIALS_ROOT" || exit $?
[[ -n "$AGE_KEY" ]] || { echo "FATAL: SOPS_AGE_KEY_FILE is required" >&2; exit 2; }
[[ -n "$SECRETS_BUNDLE" ]] || { echo "FATAL: KHEREP_SECRETS_BUNDLE is required" >&2; exit 2; }
kherep_validate_shell_path SOPS_AGE_KEY_FILE "$AGE_KEY" || exit $?
kherep_validate_shell_path KHEREP_SECRETS_BUNDLE "$SECRETS_BUNDLE" || exit $?
[[ -f "$AGE_KEY" ]] || { echo "FATAL: SOPS_AGE_KEY_FILE does not exist" >&2; exit 2; }

command -v sops      >/dev/null || { echo "FATAL: sops not installed"; exit 1; }
mkdir -p "$(dirname "$SECRETS_BUNDLE")"
TMP=""
ENC_TMP=""
SOPS_CFG_TMP=""
trap 'rm -f "$TMP" "$ENC_TMP" "$SOPS_CFG_TMP"' EXIT

# 1. read the recipient from the explicitly supplied key.
PUB="$(grep '^# public key:' "$AGE_KEY" | grep -oE 'age1[0-9a-z]+' | head -1)"
[[ -n "$PUB" ]] || { echo "FATAL: cannot read public key from $AGE_KEY"; exit 1; }
SOPS_CFG_TMP="$(mktemp)"
cat > "$SOPS_CFG_TMP" <<EOF
creation_rules:
  - path_regex: secrets/.*\.sops\.ya?ml\$
    age: "$PUB"
EOF

# 2. build base64 payload from live files
TMP="$(mktemp)"
CLAUDE_HOME="$CLAUDE_HOME" node -e '
const fs=require("fs"),h=process.env.CLAUDE_HOME;
const b64=p=>fs.existsSync(p)?fs.readFileSync(p).toString("base64"):"";
const out={
  mcp_json:           b64(h+"/.mcp.json"),
};
const miss=Object.entries(out).filter(([k,v])=>!v).map(([k])=>k);
if(miss.length){
  console.error("FATAL missing required live secrets:",miss.join(","));
  process.exit(2);
}
fs.writeFileSync(process.argv[1],"data:\n"+Object.entries(out).map(([k,v])=>"  "+k+": "+v).join("\n")+"\n");
' "$TMP"

# 3. Encrypt to a same-directory temporary file, then atomically replace the
# prior bundle only after sops succeeds and produced non-empty ciphertext.
ENC_TMP="$(mktemp "$(dirname "$SECRETS_BUNDLE")/.kherep-secrets.XXXXXX")"
SOPS_AGE_KEY_FILE="$AGE_KEY" sops --config "$SOPS_CFG_TMP" --age "$PUB" --input-type yaml --output-type yaml -e "$TMP" > "$ENC_TMP"
[[ -s "$ENC_TMP" ]] || { echo "FATAL: sops produced an empty bundle" >&2; exit 1; }
mv "$ENC_TMP" "$SECRETS_BUNDLE"
ENC_TMP=""
echo "wrote external encrypted bundle"
