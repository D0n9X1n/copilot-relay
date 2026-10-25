# Types each line given on stdin into a real interactive shell, presses Tab, then turns the
# completed line into a print command and runs it, so the output shows exactly what completion
# inserted and whether the shell would run any of it. Prints "LINE: <completed line>" per input
# line. Usage:
#   zsh -f shell-line.zsh <setup-command> <print-prefix> <shell> [args...] < lines
#
# <setup-command> runs first in the shell, for example to load a completion script. <print-prefix>
# is typed at the start of each completed line, for example "echo LINE:" for bash.
#
# Output is read with zpty -m up to a marker printed after each line. A plain zpty -r returns only
# whole lines, so text left on the prompt line would never be read. Each marker is typed as
# READY""-<n>, so the echoed command does not match it and only the printed READY-<n> does.
zmodload zsh/zpty

setup=$1
prefix=$2
shift 2

read_until() {
  local output
  if ! zpty -r -m shell output "*READY-$1*"; then
    print -u2 "shell-line: the shell ended before READY-$1"
    exit 1
  fi

  print -r -- "$output"
}

zpty shell "$@"
zpty -w shell "$setup; echo READY\"\"-0"
read_until 0 > /dev/null

round=0
while IFS= read -r line; do
  round=$(( round + 1 ))
  zpty -w -n shell "$line"$'\t'
  sleep 1
  # Ctrl-A moves to the start of the line, where the print prefix makes the shell print the
  # completed words instead of running them.
  zpty -w shell $'\x01'"$prefix "
  zpty -w shell "echo READY\"\"-$round"
  # The printed line follows the prompt, so it is taken from where LINE: starts.
  read_until $round | tr -d '\r' | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | grep -a -o 'LINE:.*' | tail -1
done

zpty -d shell
