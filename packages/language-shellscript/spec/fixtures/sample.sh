#!/usr/bin/env bash
# <- comment.line.number-sign.shell

# These assertions deliberately favour constructs driven by the parser's
# external scanner — heredocs, strings, expansions and command substitution.
# A scanner regression still compiles every query cleanly, so nothing but a
# fixture like this one would catch it.

name="world"
# <- variable.other.member.shell
#    ^ string.quoted.double.shell

readonly greeting='hi there'
# <- storage.modifier
#                 ^ string.quoted.single.shell

escaped=$'a\tb'
#       ^ string.quoted.single.dollar.shell

count=42
#     ^ constant.numeric.decimal.shell

greet() {
# <- entity.name.function.shell
  echo "hello ${name}"
# ^ support.function.builtin
#              ^ punctuation.definition.variable.begin.shell
  printf '%s\n' "$name"
#                ^ variable.other.normal.shell
}

# A heredoc: the scanner owns both the delimiter and the body, and a
# regression here typically corrupts everything that follows it.
cat <<EOF
#   ^ punctuation.definition.string.begin.heredoc.shell
this body is not code $name
EOF

# Everything below is the real regression signal — it only highlights
# correctly if the heredoc above was scanned and terminated properly.
today=$(date +%F)
#     ^ string.quoted.interpolated.dollar.shell

files=(alpha beta gamma)
#      ^ string.unquoted.shell

if [[ -n "$today" ]]; then
# <- keyword.control
#  ^ punctuation.brace.double-square.begin.shell
  greet | tee /dev/null
#       ^ keyword.operator.pipe.shell
elif [[ $count -gt 1 ]]; then
# <- keyword.control
  echo 'fallback' >&2
#                 ^ keyword.operator.redirect.shell
else
# <- keyword.control
  return 1
# ^ keyword.control.return.shell
fi
# <- keyword.control

for item in "${files[@]}"; do
# <- keyword.control
  unset item
# ^ support.function.builtin.unset.shell
done
# <- keyword.control

while true && false; do
#           ^ keyword.operator.logical.shell
  break
done

# `(( ))` is a compound statement, not a test command — the two are easy to
# confuse and upstream has moved this once already.
(( count += 1 ))
# <- punctuation.brace.double-round.begin.shell
#             ^ punctuation.brace.double-round.end.shell
