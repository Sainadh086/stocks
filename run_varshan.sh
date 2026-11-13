#!/bin/sh
# Keep the original Mac foreground command compatible with web.sh.
exec sh "$(dirname -- "$0")/web.sh" _serve "$@"
