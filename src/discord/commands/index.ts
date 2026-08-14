import {
  clearLicenseCommand,
  createAccountCommand,
  deactivateAccountCommand,
  resetPasswordCommand,
} from './accountCommands.js';
import { agentStatusCommand, licenseUsageCommand, recentActionsCommand } from './infoCommands.js';
import { helpCommand, loginStatusCommand, reconnectCommand } from './systemCommands.js';
import type { CommandDefinition } from './shared.js';

/** Every slash command, in the order they appear in the help text. */
export const COMMANDS: readonly CommandDefinition[] = [
  createAccountCommand,
  clearLicenseCommand,
  resetPasswordCommand,
  deactivateAccountCommand,
  licenseUsageCommand,
  agentStatusCommand,
  recentActionsCommand,
  loginStatusCommand,
  reconnectCommand,
  helpCommand,
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export function findCommand(name: string): CommandDefinition | undefined {
  return BY_NAME.get(name);
}

/** The payloads sent to Discord when registering commands. */
export function commandPayloads(): unknown[] {
  return COMMANDS.map((command) => command.build().toJSON());
}

export type { CommandDefinition } from './shared.js';
