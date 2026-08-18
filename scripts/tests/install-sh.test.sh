#!/bin/sh
# Exercises install.sh's uninstall path against a throwaway HOME. Uninstall
# returns before detect_platform, so none of this touches the network and the
# suite is safe to run anywhere.
#
#   sh scripts/tests/install-sh.test.sh [path/to/install.sh]
#
# `<condition>; check "name" $?` is the assertion idiom throughout. SC2319 and
# SC2181 both want an `if` instead, but reading $? straight off the condition is
# the whole point here, and an `if` per assertion would triple the file.
# shellcheck disable=SC2319,SC2181,SC2016,SC2012
SRC="${1:-"$(dirname "$0")/../install.sh"}"
[ -f "$SRC" ] || { echo "no installer at $SRC" >&2; exit 1; }
PASS=0
FAIL=0

check() { # check <name> <condition-exit-code> [detail]
  if [ "$2" -eq 0 ]; then
    printf '  PASS  %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s  %s\n' "$1" "${3:-}"
    FAIL=$((FAIL + 1))
  fi
}

ROOT="${TMPDIR:-/tmp}/agav-sh-test.$$"
rm -rf "$ROOT"
mkdir -p "$ROOT"

# Each case gets a pristine HOME so profiles and ~/.agav cannot leak between
# tests. Returns with $H, $BIN, $DATA set.
fresh() {
  H="$ROOT/$1"
  BIN="$H/.local/bin"
  DATA="$H/.agav"
  rm -rf "$H"
  mkdir -p "$BIN" "$DATA"
}

# Run the installer with everything pointed at the throwaway HOME. Output lands
# in $OUT, exit status in $CODE.
run() {
  OUT="$(HOME="$H" AGAV_INSTALL_DIR="$BIN" AGAV_HOME="$DATA" sh "$SRC" "$@" 2>&1)"
  CODE=$?
}

BEGIN="# >>> Agav installer >>>"
END="# <<< Agav installer <<<"

write_block() { # write_block <profile> [dir]
  printf '\n%s\nexport PATH="%s:$PATH"\n%s\n' "$BEGIN" "${2:-$BIN}" "$END" >>"$1"
}

echo "== a normal uninstall =="
fresh normal
: >"$BIN/agav"
mkdir -p "$DATA/packages/standalone/agav-v1"
run --uninstall
check "exits 0" "$CODE" "code=$CODE out=$OUT"
[ ! -e "$BIN/agav" ]; check "binary removed" $?
[ ! -d "$DATA/packages/standalone" ]; check "standalone release tree removed" $?
[ ! -d "$DATA/packages" ]; check "empty packages/ dir removed" $?
echo "$OUT" | grep -q "Uninstalled Agav"; check "reports success" $?

echo "== no profile block: must not abort early =="
# `[ -n \"\$x\" ] && removed=1` under set -e exits the script the moment the
# test is false, silently, before anything is reported.
fresh noblock
: >"$BIN/agav"
run --uninstall
check "exits 0" "$CODE" "code=$CODE out=$OUT"
echo "$OUT" | grep -q "Uninstalled Agav"; check "still reached the success message" $? "out=$OUT"
echo "$OUT" | grep -qv "Restart your shell"; check "no spurious restart hint" $?

echo "== a dangling symlink still counts as installed =="
fresh dangling
ln -s "$ROOT/gone-forever" "$BIN/agav"
run --uninstall
check "exits 0" "$CODE" "code=$CODE out=$OUT"
[ ! -L "$BIN/agav" ]; check "broken symlink removed" $?

echo "== packages/ is spared when something else lives there =="
fresh otherpkg
: >"$BIN/agav"
mkdir -p "$DATA/packages/somebody-elses"
run --uninstall
[ -d "$DATA/packages/somebody-elses" ]; check "unrelated package dir spared" $?

echo "== the PATH block comes back out =="
fresh oneprofile
: >"$BIN/agav"
printf 'export EDITOR=vi\n' >"$H/.zshrc"
write_block "$H/.zshrc"
printf 'alias ll="ls -l"\n' >>"$H/.zshrc"
run --uninstall
check "exits 0" "$CODE" "code=$CODE out=$OUT"
grep -qF "$BEGIN" "$H/.zshrc"; [ $? -ne 0 ]; check "begin marker gone" $?
grep -qF "$END" "$H/.zshrc"; [ $? -ne 0 ]; check "end marker gone" $?
grep -qF 'export PATH' "$H/.zshrc"; [ $? -ne 0 ]; check "the exported PATH line gone" $?
grep -qF 'export EDITOR=vi' "$H/.zshrc"; check "line before the block kept" $?
grep -qF 'alias ll="ls -l"' "$H/.zshrc"; check "line after the block kept" $?
echo "$OUT" | grep -q "Removed the Agav PATH entry from $H/.zshrc"; check "names the profile it edited" $? "out=$OUT"
echo "$OUT" | grep -q "Restart your shell"; check "tells you to restart the shell" $?

echo "== every profile that has one, not just the shell we guessed =="
fresh manyprofiles
: >"$BIN/agav"
for p in .zprofile .bash_profile .zshrc .bashrc .profile; do
  printf '# mine\n' >"$H/$p"
  write_block "$H/$p"
done
run --uninstall
n=0
for p in .zprofile .bash_profile .zshrc .bashrc .profile; do
  if ! grep -qF "$BEGIN" "$H/$p" && grep -qF '# mine' "$H/$p"; then n=$((n + 1)); fi
done
[ "$n" -eq 5 ]; check "all 5 profiles cleaned, contents kept" $? "cleaned=$n"

echo "== a profile containing nothing but our block ends up empty =="
fresh onlyblock
: >"$BIN/agav"
: >"$H/.profile"
write_block "$H/.profile"
run --uninstall
[ -f "$H/.profile" ]; check "profile still exists" $?
[ ! -s "$H/.profile" ]; check "profile is empty, not left with stray blank lines" $? "content=$(od -c "$H/.profile" | head -2)"

echo "== install/uninstall cycles do not pile up blank lines =="
fresh cycles
: >"$BIN/agav"
printf 'export EDITOR=vi\n' >"$H/.profile"
before="$(wc -l <"$H/.profile")"
i=0
while [ "$i" -lt 3 ]; do
  write_block "$H/.profile"
  run --uninstall
  : >"$BIN/agav"
  i=$((i + 1))
done
after="$(wc -l <"$H/.profile")"
[ "$before" -eq "$after" ]; check "line count unchanged after 3 cycles" $? "before=$before after=$after"

echo "== the profile keeps its identity =="
fresh inode
: >"$BIN/agav"
printf 'export EDITOR=vi\n' >"$H/.profile"
write_block "$H/.profile"
chmod 600 "$H/.profile"
ino_before="$(ls -i "$H/.profile" | awk '{print $1}')"
mode_before="$(ls -l "$H/.profile" | cut -c1-10)"
run --uninstall
ino_after="$(ls -i "$H/.profile" | awk '{print $1}')"
mode_after="$(ls -l "$H/.profile" | cut -c1-10)"
[ "$ino_before" = "$ino_after" ]; check "same inode (not replaced by a mv)" $? "$ino_before vs $ino_after"
[ "$mode_before" = "$mode_after" ]; check "same permissions" $? "$mode_before vs $mode_after"

echo "== a stale block pointing at some other dir is still ours to remove =="
fresh otherdir
: >"$BIN/agav"
printf '# mine\n' >"$H/.zshrc"
write_block "$H/.zshrc" "/some/older/agav/dir"
run --uninstall
grep -qF "$BEGIN" "$H/.zshrc"; [ $? -ne 0 ]; check "block removed regardless of the dir inside it" $?

echo "== plain --uninstall keeps your data =="
fresh keepdata
: >"$BIN/agav"
printf '{}' >"$DATA/settings.json"
run --uninstall
check "exits 0" "$CODE" "code=$CODE"
[ -f "$DATA/settings.json" ]; check "settings survive" $?
echo "$OUT" | grep -q "Kept your settings"; check "says what it kept" $? "out=$OUT"
echo "$OUT" | grep -q -- "--purge"; check "says how to remove it" $?

echo "== --purge removes your data =="
fresh purge
: >"$BIN/agav"
printf '{}' >"$DATA/settings.json"
run --purge
check "exits 0" "$CODE" "code=$CODE out=$OUT"
[ ! -e "$BIN/agav" ]; check "--purge implies --uninstall: binary gone" $?
[ ! -d "$DATA" ]; check "data directory gone" $?
echo "$OUT" | grep -q "Removed $DATA"; check "reports the removal" $? "out=$OUT"
echo "$OUT" | grep -qv "Kept your settings"; check "does not also claim it kept anything" $?

echo "== --purge after the binary was removed by hand =="
# The point of --purge is the data. Refusing because the binary is already gone
# would strand it there for good.
fresh purgeonly
printf '{}' >"$DATA/settings.json"
run --purge
check "exits 0" "$CODE" "code=$CODE out=$OUT"
[ ! -d "$DATA" ]; check "data directory gone" $?

echo "== nothing to do at all still fails =="
fresh nothing
rm -rf "$DATA"
run --purge
[ "$CODE" -eq 1 ]; check "exits 1" $? "code=$CODE"
echo "$OUT" | grep -q "not found"; check "says not found" $? "out=$OUT"

echo "== a home directory with a space in it =="
# `for p in $path_removed_from` split one path into several, so the summary
# claimed to have edited four profiles that do not exist.
fresh "John Smith"
: >"$BIN/agav"
for p in .zshrc .profile; do
  printf '# mine\n' >"$H/$p"
  write_block "$H/$p"
done
run --uninstall
[ "$(echo "$OUT" | grep -c 'Removed the Agav PATH entry')" -eq 2 ]
check "one message per profile, not one per word" $? "out=$OUT"
echo "$OUT" | grep -qF "Removed the Agav PATH entry from $H/.zshrc"; check "the path is intact" $?
grep -qF "$BEGIN" "$H/.zshrc"; [ $? -ne 0 ]; check "profile still actually cleaned" $?

echo "== no scratch files left behind =="
[ -z "$(find "$H" -name '*.agav-uninstall.*' -o -name '*.agav-profile.*' -o -name '*.agav-install.*')" ]
check "no temp files in HOME" $? "$(find "$H" -name '*agav-*')"
[ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'agav-uninstall.*' -o -maxdepth 1 -name 'agav-profile.*' 2>/dev/null)" ]
check "no temp files in TMPDIR" $?

echo "== --help =="
fresh help
run --help
check "exits 0" "$CODE" "code=$CODE"
echo "$OUT" | grep -q -- "--purge"; check "documents --purge" $? "out=$OUT"
echo "$OUT" | grep -q "keeping your settings"; check "says plain uninstall keeps your data" $?
[ -e "$BIN/agav" ] || true
echo "$OUT" | grep -qv "Uninstalled"; check "--help does not uninstall" $?

rm -rf "$ROOT"
echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
