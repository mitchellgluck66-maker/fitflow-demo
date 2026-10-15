#!/bin/sh
# Project tint — colours this terminal so the project is obvious at a glance.
# Runs from the Claude Code SessionStart hook AND by hand. Never fails silently:
# every run appends to .claude/tint.log. Safe to delete; nothing depends on it.
NAME="FITFLOW"
HEX="1d1b2e"
LOG="$(dirname "$0")/tint.log"
say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null; }
say "start: $NAME #$HEX TERM_PROGRAM=${TERM_PROGRAM:-<unset>}"

# ---- 1. Terminal.app, via AppleScript. FIRST, because this does NOT need a tty,
#         and a hook has no controlling terminal (that is why the old order failed).
if [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ]; then
  R=$(printf '%d' "0x$(printf '%s' "$HEX" | cut -c1-2)")
  G=$(printf '%d' "0x$(printf '%s' "$HEX" | cut -c3-4)")
  B=$(printf '%d' "0x$(printf '%s' "$HEX" | cut -c5-6)")
  OUT=$(osascript \
    -e "tell application \"Terminal\"" \
    -e "set background color of front window to {$((R*257)), $((G*257)), $((B*257))}" \
    -e "set custom title of front window to \"$NAME\"" \
    -e "end tell" 2>&1)
  if [ $? -eq 0 ]; then say "ok: Terminal.app background + title set"
  else say "FAILED: AppleScript — $OUT"; fi
fi

# ---- 2. Everything else, via escape codes. Only possible with a tty, so this
#         works when run by hand and is skipped (logged) from a hook.
# The 2>/dev/null must wrap the open: redirections apply left to right, so `exec 3>/dev/tty 2>/dev/null`
# printed "Device not configured" from a shell with no controlling terminal (a hook, or `!` in Claude Code).
if [ -c /dev/tty ] && { exec 3>/dev/tty; } 2>/dev/null; then
  printf '\033]0;%s\033\\' "$NAME" >&3
  printf '\033]11;#%s\033\\' "$HEX" >&3
  [ "${TERM_PROGRAM:-}" = "iTerm.app" ] && printf '\033]1337;SetBadgeFormat=%s\a' "$(printf '%s' "$NAME" | base64 | tr -d '\n')" >&3
  say "ok: escape codes sent to /dev/tty"
else
  say "note: no tty (normal from a hook) — escape codes skipped; AppleScript above is the live path"
fi
say "done"
exit 0
