#!/bin/sh
# Lift add_to_path out of the shipped installer and exercise it directly; the
# install flow around it needs the network, this function does not.
#
#   sh scripts/tests/install-sh-path.test.sh [path/to/install.sh]
#
# See install-sh.test.sh for why SC2319/SC2181 are off. SC2034 fires on the
# globals the lifted functions read ($os, $BIN_DIR) - they look unused here
# because their only reader arrives via eval.
# shellcheck disable=SC2319,SC2181,SC2016,SC2012,SC2034,SC2154
SRC="${1:-"$(dirname "$0")/../install.sh"}"
[ -f "$SRC" ] || { echo "no installer at $SRC" >&2; exit 1; }
PASS=0; FAIL=0
check() { if [ "$2" -eq 0 ]; then printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); else printf '  FAIL  %s  %s\n' "$1" "${3:-}"; FAIL=$((FAIL+1)); fi; }

eval "$(awk '/^pick_profile\(\) \{/,/^\}/' "$SRC")"
eval "$(awk '/^add_to_path\(\) \{/,/^\}/' "$SRC")"

R="${TMPDIR:-/tmp}/agav-addpath.$$"; rm -rf "$R"

# add_to_path reads $PATH to decide whether there is anything to do, so the
# cases below leave it alone rather than overriding it: a stripped-down PATH
# also strips the ls/cat/rm the function itself calls. The directories used
# here are fictional, so the ambient PATH never contains them.
case ":$PATH:" in *":/opt/agav/bin:"*|*":/opt/new/bin:"*)
  echo "refusing to run: PATH already contains a directory this suite pretends is absent" >&2
  exit 1 ;;
esac

fresh() { HOME="$R/$1"; mkdir -p "$HOME"; os="linux"; SHELL="/bin/bash"; BIN_DIR="$2"; }
BEGIN="# >>> Agav installer >>>"

echo "== appends a block to a profile that has none =="
fresh plain /opt/agav/bin
printf 'export EDITOR=vi\n' >"$HOME/.bashrc"
add_to_path
grep -qF "$BEGIN" "$HOME/.bashrc"; check "block written" $?
grep -qF 'export PATH="/opt/agav/bin:$PATH"' "$HOME/.bashrc"; check "correct PATH line" $?
[ "$path_action" = "added" ]; check "reports added" $? "$path_action"

echo "== rewrites a block that points somewhere else (the temp-file branch) =="
fresh rewrite /opt/new/bin
printf '# top\n\n%s\nexport PATH="/opt/old/bin:$PATH"\n# <<< Agav installer <<<\n# bottom\n' "$BEGIN" >"$HOME/.bashrc"
ino_before="$(ls -i "$HOME/.bashrc" | awk '{print $1}')"
add_to_path
grep -qF 'export PATH="/opt/new/bin:$PATH"' "$HOME/.bashrc"; check "new dir written" $?
grep -qF '/opt/old/bin' "$HOME/.bashrc"; [ $? -ne 0 ]; check "old dir gone" $?
[ "$(grep -cF "$BEGIN" "$HOME/.bashrc")" -eq 1 ]; check "exactly one block, not two" $?
grep -qF '# top' "$HOME/.bashrc" && grep -qF '# bottom' "$HOME/.bashrc"; check "surrounding lines kept" $?
[ "$ino_before" = "$(ls -i "$HOME/.bashrc" | awk '{print $1}')" ]; check "same inode" $?
[ -z "$(find "$HOME" -name '*.agav-install.*')" ]; check "no scratch file left in HOME" $? "$(find "$HOME" -name '*agav*')"
[ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'agav-profile.*' 2>/dev/null)" ]; check "nothing written to /tmp" $?

echo "== a home directory with a space, on the rewrite branch =="
fresh "Jane Doe" "/opt/new/bin"
printf '%s\nexport PATH="/opt/old/bin:$PATH"\n# <<< Agav installer <<<\n' "$BEGIN" >"$HOME/.bashrc"
add_to_path
grep -qF 'export PATH="/opt/new/bin:$PATH"' "$HOME/.bashrc"; check "rewrite still works" $?
[ -z "$(find "$R" -name '*.agav-install.*')" ]; check "no scratch file left" $?

echo "== already on PATH: profile untouched =="
fresh onpath /opt/agav/bin
printf 'export EDITOR=vi\n' >"$HOME/.bashrc"
PATH="$PATH:/opt/agav/bin" add_to_path
grep -qF "$BEGIN" "$HOME/.bashrc"; [ $? -ne 0 ]; check "nothing written" $?

rm -rf "$R"
echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
