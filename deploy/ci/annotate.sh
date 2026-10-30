#!/usr/bin/env bash
# annotate.sh <title> <file>: show the end of a file as a GitHub error annotation.
# Annotations are cut at 4 KB, so each component gets its own.
set -u
title=$1
file=$2
[ -s "$file" ] || exit 0
msg=$(tail -c 3800 "$file" | sed -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')
echo "::error title=$title::$msg"
