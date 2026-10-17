#!/usr/bin/env bash
#
# Update packaging/homebrew/astrocode.rb to a published npm version.
#
#   ./scripts/bump-formula.sh 1.3.1
#
# Fetches the npm tarball for the given version, computes its sha256, and
# rewrites the `url` and `sha256` lines in the formula. Requires the version to
# already be published to the npm registry.
#
set -euo pipefail

PKG="astrocode"
FORMULA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packaging/homebrew/astrocode.rb"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>   (e.g. $0 1.3.1)" >&2
  exit 1
fi
VERSION="${VERSION#v}"

[ -f "$FORMULA" ] || { echo "formula not found: $FORMULA" >&2; exit 1; }

URL="https://registry.npmjs.org/${PKG}/-/${PKG}-${VERSION}.tgz"
echo "Fetching $URL"

SHA="$(curl -fsSL "$URL" | shasum -a 256 | cut -d' ' -f1)" ||
  { echo "could not download $URL — is $VERSION published?" >&2; exit 1; }

if [ "${#SHA}" -ne 64 ]; then
  echo "unexpected sha256: $SHA" >&2
  exit 1
fi

# BSD and GNU sed disagree about -i; write to a temp file instead.
TMP="$(mktemp)"
sed -E \
  -e "s|astrocode-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${PKG}-${VERSION}.tgz|" \
  -e "s|sha256 \"[0-9a-f]{64}\"|sha256 \"${SHA}\"|" \
  "$FORMULA" > "$TMP"
mv "$TMP" "$FORMULA"

echo "Updated $(basename "$FORMULA")"
echo "  version: $VERSION"
echo "  sha256:  $SHA"
echo
echo "Copy it into your tap repo:"
echo "  github.com/ahsannadir/homebrew-tap/Formula/astrocode.rb"
