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

  integrations.gitnr.".gitignore" = {
    templates = [
      "gh:Node"
      "gh:Nix"
    ];
    content = [
      "*.tsbuildinfo"
      "*.tgz"
      ".DS_Store"
      "/packages/*/lib/"
      "storybook-static/"
      ".devenv*"
      "devenv.local.nix"
      "devenv.local.yaml"
      ".direnv"
      ".pi/"
      ".dsh/"
      ".tmp/"
      ".tca-runtime-*/"
    ];
  };
}
