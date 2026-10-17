# Homebrew formula for AstroCode.
#
# This file belongs in a tap repo named `homebrew-tap` under your GitHub
# account, at `Formula/astrocode.rb`:
#
#   github.com/ahsannadir/homebrew-tap/Formula/astrocode.rb
#
# Users then install with:
#
#   brew install ahsannadir/tap/astrocode
#
# (A bare `brew install astrocode` only works once the formula ships in
# homebrew-core, which requires notability thresholds. Use the tap.)
#
# After each npm publish, update `version` and `sha256` below. Get the hash with:
#
#   curl -sL https://registry.npmjs.org/astrocode/-/astrocode-<version>.tgz | shasum -a 256
#
# or simply run:  ./scripts/bump-formula.sh 1.3.0

class Astrocode < Formula
  desc "Fast terminal coding agent with 16 tools, sub-agents, and swarm mode"
  homepage "https://github.com/ahsannadir/astrocode"
  url "https://registry.npmjs.org/astrocode/-/astrocode-1.3.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/astrocode --version")
  end
end
