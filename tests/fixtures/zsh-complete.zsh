# Types each line given on stdin into a real interactive zsh, presses Tab, and prints the matches
# completion offered: "=== <line>" and then one match per line. Usage:
#   zsh -f zsh-complete.zsh <completion-script> <work-directory> < lines
#
# The matches are read by wrapping compadd, which every completion function calls to offer a match,
# so the result does not depend on how the terminal draws the list.
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
  local attempt
  for attempt in {1..100}; do
    drain
    if grep -q -- "$1" $screen 2>/dev/null; then
      return 0
    fi

    sleep 0.1
  done

  print -u2 "zsh-complete: timed out waiting for $1"
  exit 1
}

zpty shell zsh -f -i
zpty -w shell "autoload -Uz compinit; compinit -u -d '$work/zcompdump'; source '$script'; setopt nobeep; print LOADED"
wait_for LOADED
zpty -w shell "compadd() { local -a found; builtin compadd -O found \"\$@\"; print -rl -- \"\${found[@]}\" >> '$matches'; builtin compadd \"\$@\"; }; print WRAPPED"
wait_for WRAPPED

while IFS= read -r line; do
  : >| $matches
  zpty -w -n shell "$line"$'\t'
  for attempt in {1..50}; do
    drain
    if [[ -s $matches ]]; then
      break
    fi

    sleep 0.1
  done

  sleep 0.3
  drain
  print -r -- "=== $line"
  sort -u $matches | grep -v '^[[:space:]]*$'
  zpty -w -n shell $'\x03'
  sleep 0.2
  drain
done

zpty -d shell
