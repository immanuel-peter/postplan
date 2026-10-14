#!/usr/bin/env bash
# Usage: field.sh <json-file> <key>   (prints one top-level field of a saved response body)
node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; console.log(typeof v === "object" ? JSON.stringify(v) : v)' "$1" "$2"
