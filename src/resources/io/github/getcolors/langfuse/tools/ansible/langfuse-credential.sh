#!/usr/bin/env bash
# The project API keys and the initial user, for an operator over SSH.
# Deliberately a separate command from langfuse-status: routine health output
# must not carry a credential.
set -euo pipefail
echo "host:            https://<{ langfuse-host }>"
echo "user:            <{ langfuse-init-user-email }> (password: COLORS_PAR_LANGFUSE_INIT_USER_PASSWORD, operator-held)"
echo "project:         <{ langfuse-init-project-id }>"
echo "public key:      $(cat /etc/langfuse/secrets/project_public_key)"
echo "secret key:      $(cat /etc/langfuse/secrets/project_secret_key)"
