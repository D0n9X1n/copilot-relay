# Types each line given on stdin into a real interactive zsh, presses Tab, and prints the matches
# completion offered: "=== <line>" and then one match per line. Usage:
#   zsh -f zsh-complete.zsh <completion-script> <work-directory> < lines
#
# The matches are read by wrapping compadd, which every completion function calls to offer a match,
# so the result does not depend on how the terminal draws the list. A function in comppostfuncs
# writes an end marker once a completion has finished, and each line waits for a fresh prompt
# before it is typed, so one line's output never runs into the next.
zmodload zsh/zpty

script=$1
work=$2
screen=$work/screen
matches=$work/matches
: >| $screen

drain() {
  local chunk
  while zpty -r -t shell chunk 2>/dev/null; do
    print -rn -- "$chunk" >> $screen
  done
}

wait_for() {
  local file=$1 text=$2 attempt
  for attempt in {1..200}; do
    drain
    if grep -q -- "$text" $file 2>/dev/null; then
      return 0
    fi

    sleep 0.05
  done

  print -u2 "zsh-complete: timed out waiting for $text"
  exit 1
}

zpty shell zsh -f -i
zpty -w shell "autoload -Uz compinit; compinit -u -d '$work/zcompdump'; source '$script'; setopt nobeep; print LOADED"
wait_for $screen LOADED
zpty -w shell "compadd() { local -a found; builtin compadd -O found \"\$@\"; print -rl -- \"\${found[@]}\" >> '$matches'; builtin compadd \"\$@\"; }; copilot_relay_done() { print -r -- COMPLETION-END >> '$matches'; }; zstyle ':completion:*' completer _copilot_relay_mark _complete; _copilot_relay_mark() { comppostfuncs+=(copilot_relay_done); return 1; }; print WRAPPED"
wait_for $screen WRAPPED

round=0
while IFS= read -r line; do
  round=$(( round + 1 ))
  : >| $matches
  zpty -w -n shell "$line"$'\t'
  wait_for $matches COMPLETION-END
  print -r -- "=== $line"
  grep -v -e '^COMPLETION-END$' -e '^[[:space:]]*$' $matches | sort -u
  zpty -w -n shell $'\x03'
  zpty -w shell "print NEXT-$round"
  wait_for $screen "NEXT-$round"
done

zpty -d shell
