{ pkgs, ... }:
{
  packages = with pkgs; [
    fish
    git
    jujutsu
    python3
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs-slim_24;
    corepack.enable = true;
  };

  integrations.gitnr.".gitignore".content = [
    "node_modules/"
    ".pnpm-store/"
    "/packages/*/lib/"
    "*.tsbuildinfo"
    "*.tgz"
    ".smoke-dsh-home/"
    ".DS_Store"
    ".dsh/"
    ".pnpm-run/"
    ".pnpm-state/"
    ".dsmoke/"
    ".bw-fixture/"
    ".tca-runtime-*/"
    "storybook-static/"
    ".tmp/"
    ".devenv*"
    "devenv.local.nix"
    "devenv.local.yaml"
    ".direnv"
    ".pre-commit-config.yaml"
  ];
}
