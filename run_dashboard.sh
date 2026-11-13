#!/bin/sh
# Compatibility launcher: the complete application now runs on Node.js.
exec sh "$(dirname -- "$0")/run_varshan.sh" "$@"
