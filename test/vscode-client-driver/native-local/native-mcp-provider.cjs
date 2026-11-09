'use strict';
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { basename, isAbsolute, join } = require('node:path');
const providerId = 'native-proof-fixture';

function activateMcpFixture(vscode, context, fixture, requireTrustedFixture, write) {
  if (fixture.enable_mcp_fixture !== true) return;
  requireTrustedFixture();
  const nonce = fixture.mcp_fixture_nonce, node = fixture.mcp_fixture_node;
  if (typeof nonce !== 'string' || !/^[a-f0-9]{16,128}$/.test(nonce) || !isAbsolute(node ?? '') || !existsSync(node)) throw Error('MCP_FIXTURE_CONFIGURATION_INVALID');
  const script = join(__dirname, 'native-mcp-fixture.cjs'), evidence = join(fixture.evidence, 'native-mcp');
  const version = createHash('sha256').update(readFileSync(script)).update(nonce).digest('hex');
  const args = [script, '--nonce', nonce, '--evidence', evidence];
  if (fixture.mcp_fixture_hold_until_release === true) args.push('--gate-file', join(evidence, 'release-echo.flag'));
  const registration = vscode.lm.registerMcpServerDefinitionProvider(providerId, {
    provideMcpServerDefinitions() {
      requireTrustedFixture();
      write('native-mcp-registration.json', { state: 'definition-provided', provider_id: providerId, label: 'Native Fixture',
        version, command_basename: basename(node), invocation: 'not-observed' });
      return [new vscode.McpStdioServerDefinition('Native Fixture', node, [...args], undefined, version)];
    },
    resolveMcpServerDefinition(server, cancellation) {
      requireTrustedFixture();
      if (cancellation?.isCancellationRequested || server.label !== 'Native Fixture') return;
      // VS Code owns server trust and per-tool approvals. This provider neither
      // sets approval policy nor calls a private start-server command.
      write('native-mcp-registration.json', { state: 'definition-resolved', provider_id: providerId, label: 'Native Fixture',
        version, command_basename: basename(node), invocation: 'not-observed' });
      return server;
    },
  });
  context.subscriptions.push(registration);
  return registration;
}

module.exports = { activateMcpFixture, providerId };
