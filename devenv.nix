{ pkgs, ... }:
{
  languages.clojure.enable = true;
  languages.opentofu.enable = true;
  packages = with pkgs; [ ansible babashka bun curl jq openssh openssl postgresql rclone uv ];
}
