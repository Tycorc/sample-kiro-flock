/**
 * Generate the per-instance cloud-init shell script that turns a vanilla
 * Amazon Linux 2023 AMI into an AGA agent.
 *
 * The script:
 *   1. Installs Node.js 20 and unzip
 *   2. Installs kiro-cli from the official zip
 *   3. Downloads the agent bundle from s3://<bucket>/agent/bundle.zip
 *   4. Writes /etc/aga/agent.json with this instance's config
 *   5. Writes and starts a systemd unit that runs `node bootstrap.js`
 */

export interface AgentUserDataConfig {
  agentIndex: number;
  concurrency: number;
  neighbourRadius: number;
  bucket: string;
  region: string;
  loopIntervalSeconds: number;
  model: string | null;
}

/** JSON-encode for embedding inside a single-quoted heredoc in bash. */
function jsonForHeredoc(value: unknown): string {
  // The heredoc uses 'EOF' (quoted) so bash will not interpolate — we just
  // need JSON that does not contain a line starting with `EOF`. Pretty-print
  // for readability; JSON itself never contains a bare `EOF` line.
  return JSON.stringify(value, null, 2);
}

export function renderAgentUserData(cfg: AgentUserDataConfig): string {
  const agentJson = jsonForHeredoc(cfg);

  return `#!/bin/bash
set -euxo pipefail

# ---- 1. base packages ----------------------------------------------------
dnf install -y unzip tar gzip
# curl-minimal is pre-installed on AL2023 and conflicts with full curl, skip it
# Node.js 20 (AL2023 ships with nodejs20 in the default repo)
dnf install -y nodejs20 || dnf install -y nodejs

# ---- 2. kiro-cli ---------------------------------------------------------
# The install script places binaries under ~/.local/bin. We install for
# ec2-user so the systemd service (running as ec2-user) can find it.
sudo -u ec2-user bash -eux <<'KIRO_INSTALL'
cd /tmp
curl --proto '=https' --tlsv1.2 -sSf \\
  'https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-aarch64-linux.zip' \\
  -o /tmp/kirocli.zip
unzip -q -o /tmp/kirocli.zip -d /tmp
yes | /tmp/kirocli/install.sh || /tmp/kirocli/install.sh --no-confirm || true
KIRO_INSTALL

# ---- 3. agent bundle -----------------------------------------------------
mkdir -p /opt/aga
aws s3 sync "s3://${cfg.bucket}/agent/" /opt/aga/ --region ${cfg.region}

# ---- 4. per-instance config ----------------------------------------------
mkdir -p /etc/aga
cat > /etc/aga/agent.json <<'AGENT_JSON'
${agentJson}
AGENT_JSON
chown -R ec2-user:ec2-user /opt/aga /etc/aga

# ---- 5. Kiro API key from SSM --------------------------------------------
set +x
KIRO_API_KEY="$(aws ssm get-parameter \
  --name /aga/kiro-api-key \
  --with-decryption \
  --region ${cfg.region} \
  --query Parameter.Value --output text)"
mkdir -p /etc/aga
printf 'KIRO_API_KEY=%s\n' "$KIRO_API_KEY" > /etc/aga/kiro-api-key.env
chmod 600 /etc/aga/kiro-api-key.env
chown ec2-user:ec2-user /etc/aga/kiro-api-key.env
set -x

# ---- 6. systemd unit -----------------------------------------------------
cat > /etc/systemd/system/aga-agent.service <<UNIT
[Unit]
Description=AGA agent loop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/aga
Environment=HOME=/home/ec2-user
Environment=PATH=/home/ec2-user/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=AGA_CONFIG_PATH=/etc/aga/agent.json
EnvironmentFile=/etc/aga/kiro-api-key.env
ExecStart=/usr/bin/node /opt/aga/agent/bootstrap.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now aga-agent.service
`;
}
