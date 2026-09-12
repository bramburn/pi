/**
 * Minimal stub of the pi ExtensionAPI used by unit tests.
 *
 * Records every tool/command/shortcut registration so tests can assert
 * what the extension wired up. The `flag` map mimics `pi.getFlag`.
 */

export interface MockToolRegistration {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (...args: unknown[]) => unknown;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
}

export interface MockCommandRegistration {
	name: string;
	description: string;
	handler: (...args: unknown[]) => unknown;
}

export interface MockShortcutRegistration {
	key: string;
	description: string;
	handler: (...args: unknown[]) => unknown;
}

export interface MockEventHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

export interface MockPi {
	tools: MockToolRegistration[];
	commands: MockCommandRegistration[];
	shortcuts: MockShortcutRegistration[];
	eventHandlers: MockEventHandler[];
	flags: Map<string, unknown>;
	registerTool: (def: MockToolRegistration) => void;
	registerCommand: (name: string, def: { description?: string; handler: MockCommandRegistration["handler"] }) => void;
	registerShortcut: (
		key: string,
		def: { description?: string; handler: MockShortcutRegistration["handler"] },
	) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	getFlag: (key: string) => unknown;
	sendMessage: (...args: unknown[]) => void;
}

export function createMockPi(): MockPi {
	const tools: MockToolRegistration[] = [];
	const commands: MockCommandRegistration[] = [];
	const shortcuts: MockShortcutRegistration[] = [];
	const eventHandlers: MockEventHandler[] = [];
	const flags = new Map<string, unknown>();

	return {
		tools,
		commands,
		shortcuts,
		eventHandlers,
		flags,
		registerTool(def) {
			tools.push(def);
		},
		registerCommand(name, def) {
			commands.push({ name, description: def.description ?? "", handler: def.handler });
		},
		registerShortcut(key, def) {
			shortcuts.push({ key, description: def.description ?? "", handler: def.handler });
		},
		on(event, handler) {
			eventHandlers.push({ event, handler });
		},
		getFlag(key) {
			return flags.get(key);
		},
		sendMessage() {
			/* no-op */
		},
	};
}