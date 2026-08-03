import { useMemo } from "react";
import type {
	CommandEntry,
	ExtensionEntry,
	ExtensionsSnapshot,
	ToolEntry,
} from "./types";

function AskChip({ askMode }: { askMode: ToolEntry["askMode"] }) {
	switch (askMode) {
		case "safe":
			return <span className="chip chip-safe">✓ read-only safe</span>;
		case "whitelisted":
			return <span className="chip chip-whitelisted">★ whitelisted</span>;
		case "blocked":
			return <span className="chip chip-blocked">🔒 blocked in Ask</span>;
	}
}

function CommandRow({ cmd }: { cmd: CommandEntry }) {
	return (
		<div className="row">
			<span className="cmd-name">/{cmd.name}</span>
			{cmd.description && <span className="row-desc">{cmd.description}</span>}
			{cmd.source !== "extension" && (
				<span className={`tag tag-${cmd.source}`}>{cmd.source}</span>
			)}
		</div>
	);
}

function ToolRow({ tool }: { tool: ToolEntry }) {
	return (
		<div className="row">
			<span className="tool-name">{tool.name}</span>
			{tool.label && tool.label !== tool.name && (
				<span className="row-desc">{tool.label}</span>
			)}
			<AskChip askMode={tool.askMode} />
		</div>
	);
}

function Card({
	title,
	badge,
	disabled,
	commands,
	tools,
	meta,
}: {
	title: string;
	badge: string;
	disabled?: boolean;
	commands: CommandEntry[];
	tools: ToolEntry[];
	meta?: string;
}) {
	return (
		<div className={`card${disabled ? " card-disabled" : ""}`}>
			<div className="card-title">
				<span className="card-name">{title}</span>
				<span className="badge">{badge}</span>
				{disabled && <span className="tag tag-disabled">disabled in settings</span>}
			</div>
			{commands.length > 0 && (
				<div className="group">
					<div className="group-label">Commands</div>
					{commands.map((cmd) => (
						<CommandRow key={cmd.name} cmd={cmd} />
					))}
				</div>
			)}
			{tools.length > 0 && (
				<div className="group">
					<div className="group-label">Tools</div>
					{tools.map((tool) => (
						<ToolRow key={tool.name} tool={tool} />
					))}
				</div>
			)}
			{commands.length === 0 && tools.length === 0 && (
				<div className="row-desc">no commands or tools</div>
			)}
			{meta && <div className="card-meta">{meta}</div>}
		</div>
	);
}

function matches(entry: ExtensionEntry, query: string): boolean {
	if (!query) return true;
	const hay = [
		entry.displayName,
		...entry.commands.map((c) => c.name),
		...entry.tools.map((t) => t.name),
		...entry.tools.map((t) => t.label),
	]
		.join(" ")
		.toLowerCase();
	return hay.includes(query);
}

function matchesCore(snapshot: ExtensionsSnapshot, query: string): boolean {
	if (!query) return true;
	const hay = [
		"pi core",
		...snapshot.core.commands.map((c) => c.name),
		...snapshot.core.tools.map((t) => t.name),
	]
		.join(" ")
		.toLowerCase();
	return hay.includes(query);
}

export function SnapshotTree({
	snapshot,
	query,
}: {
	snapshot: ExtensionsSnapshot;
	query: string;
}) {
	const filtered = useMemo(
		() => snapshot.extensions.filter((e) => matches(e, query)),
		[snapshot, query],
	);
	const coreVisible = matchesCore(snapshot, query);

	return (
		<div className="ext-tree">
			{filtered.map((entry) => (
				<Card
					key={entry.path}
					title={entry.displayName}
					badge={entry.source}
					disabled={!entry.enabled}
					commands={entry.commands}
					tools={entry.tools}
					meta={`${entry.events} events · ${entry.flags} flags · ${entry.shortcuts} shortcuts · ${entry.messageRenderers} renderers`}
				/>
			))}
			{coreVisible && (
				<Card
					title="pi core (SDK)"
					badge="builtin"
					commands={snapshot.core.commands}
					tools={snapshot.core.tools}
					meta="Built-in slash commands and SDK tools — not from any extension"
				/>
			)}
			{filtered.length === 0 && !coreVisible && (
				<div className="row-desc">Nothing matches “{query}”.</div>
			)}
			{snapshot.loadErrors.length > 0 && (
				<div className="card card-errors">
					<div className="card-title">
						<span className="card-name">
							{snapshot.loadErrors.length} extension(s) failed to load
						</span>
					</div>
					{snapshot.loadErrors.map((e) => (
						<div className="row" key={e.path}>
							<span className="tool-name">{e.path}</span>
							<span className="row-desc">{e.error}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
