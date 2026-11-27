#!/bin/sh
# Builds acpd and installs it for the current user.
#
#   ./scripts/install.sh
#
# ACPD_BIN_DIR  where the binary goes (default: ~/.local/bin)
#
# If that directory is not on PATH, the installer adds it to your shell's
# startup file. It also creates ~/.acpd/config.json from the example config
# when you have no user config.
set -eu

cd "$(dirname "$0")/.."
bin_dir="${ACPD_BIN_DIR:-$HOME/.local/bin}"
config_dir="$HOME/.acpd"
xdg_config="${XDG_CONFIG_HOME:-$HOME/.config}/acpd/config.json"

if ! command -v bun >/dev/null 2>&1; then
    echo "acpd: Bun is required to build acpd. Install it from https://bun.sh" >&2
    exit 1
fi

bun install --frozen-lockfile
bun run build

mkdir -p "$bin_dir"
cp dist/acpd "$bin_dir/acpd.tmp"
chmod 755 "$bin_dir/acpd.tmp"
mv -f "$bin_dir/acpd.tmp" "$bin_dir/acpd"
echo "Installed $bin_dir/acpd"

if [ ! -e "$config_dir/config.json" ] && [ ! -e "$xdg_config" ]; then
    mkdir -p "$config_dir"
    cp acpd.config.json "$config_dir/config.json"
    echo "Created $config_dir/config.json"
fi

case ":$PATH:" in
    *":$bin_dir:"*) exit 0 ;;
esac

case "$(basename "${SHELL:-sh}")" in
    zsh)
        rc="${ZDOTDIR:-$HOME}/.zshrc"
        line="export PATH=\"$bin_dir:\$PATH\"" ;;
    bash)
        # macOS opens login shells, which read ~/.bash_profile instead of ~/.bashrc.
        if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
        line="export PATH=\"$bin_dir:\$PATH\"" ;;
    fish)
        rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/acpd.fish"
        line="fish_add_path \"$bin_dir\"" ;;
    *)
        rc="$HOME/.profile"
        line="export PATH=\"$bin_dir:\$PATH\"" ;;
esac

if ! grep -qsF "$line" "$rc"; then
    mkdir -p "$(dirname "$rc")"
    printf '\n# Added by the acpd installer\n%s\n' "$line" >> "$rc"
    echo "Added $bin_dir to PATH in $rc"
fi
echo "Open a new shell, or run this to use acpd now:"
echo "  $line"
