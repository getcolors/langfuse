#!/usr/bin/env bash
# The project API keys and the initial user, for an operator over SSH.
# Deliberately a separate command from langfuse-status: routine health output
# must not carry a credential.
set -euo pipefail
echo "host:            https://langfuse.fixture.example"
echo "user:            operator@fixture.example (password: COLORS_PAR_LANGFUSE_INIT_USER_PASSWORD, operator-held)"
echo "project:         fixture-project"
echo "public key:      $(cat /etc/langfuse/secrets/project_public_key)"
echo "secret key:      $(cat /etc/langfuse/secrets/project_secret_key)"
