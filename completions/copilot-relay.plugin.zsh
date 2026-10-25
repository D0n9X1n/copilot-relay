# zsh plugin for copilot-relay: tab completion for its commands, options and values.
#
# Load it after compinit, for example as an oh-my-zsh custom plugin or with zinit, antidote or
# sheldon. It asks the installed copilot-relay for its script each time a shell starts, so the
# completion always matches the installed version.
if (( ${+commands[copilot-relay]} )); then
  eval "$(copilot-relay completion zsh)"
fi
