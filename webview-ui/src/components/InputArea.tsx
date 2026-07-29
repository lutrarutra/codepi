import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ModelOption } from "../types";

interface Props {
	streaming: boolean;
	onSend: (text: string) => void;
	onAbort: () => void;
	modelName: string;
	availableModels: ModelOption[];
	onModelSelect: (provider: string, modelId: string) => void;
}

// ── Pinning (stored in localStorage) ──────────────────────────

const PINNED_KEY = "codepi_pinned_models";

function getPinned(): Set<string> {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		return new Set(raw ? JSON.parse(raw) : []);
	} catch {
		return new Set();
	}
}

function togglePinned(key: string): Set<string> {
	const pinned = getPinned();
	if (pinned.has(key)) pinned.delete(key);
	else pinned.add(key);
	localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]));
	return pinned;
}

// ── Model Dropdown Component ──────────────────────────────────

function ModelDropdown({
	models,
	currentModel,
	onSelect,
	onClose,
	anchor,
}: {
	models: ModelOption[];
	currentModel: string;
	onSelect: (provider: string, modelId: string) => void;
	onClose: () => void;
	anchor: DOMRect | null;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState<Set<string>>(getPinned);

	// Close on click outside
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		setTimeout(() => document.addEventListener("click", handler), 0);
		return () => document.removeEventListener("click", handler);
	}, [onClose]);

	// Close on Escape
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler as any);
		return () => window.removeEventListener("keydown", handler as any);
	}, [onClose]);

	const handlePinToggle = useCallback((e: React.MouseEvent, key: string) => {
		e.stopPropagation();
		const updated = togglePinned(key);
		setPinned(new Set(updated));
	}, []);

	// Group, sort, and separate pinned models
	const { pinnedModels, groupedModels } = useMemo(() => {
		const byProvider = new Map<string, ModelOption[]>();
		for (const m of models) {
			const list = byProvider.get(m.provider) ?? [];
			list.push(m);
			byProvider.set(m.provider, list);
		}

		// Sort model names within each provider
		for (const [, list] of byProvider) {
			list.sort((a, b) => a.modelId.localeCompare(b.modelId));
		}

		// Sort providers
		const sorted = [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));

		// Split pinned vs unpinned
		const pinnedItems: Array<{ provider: string; model: ModelOption }> = [];
		const groupedItems: Array<{ provider: string; models: ModelOption[] }> = [];

		for (const [provider, list] of sorted) {
			const unpinned = list.filter((m) => !pinned.has(`${provider}/${m.modelId}`));
			const pinnedInGroup = list.filter((m) => pinned.has(`${provider}/${m.modelId}`));
			if (pinnedInGroup.length > 0) {
				for (const m of pinnedInGroup) {
					pinnedItems.push({ provider, model: m });
				}
			}
			if (unpinned.length > 0) {
				groupedItems.push({ provider, models: unpinned });
			}
		}

		return { pinnedModels: pinnedItems, groupedModels: groupedItems };
	}, [models, pinned]);

	if (!anchor) return null;

	const spaceAbove = anchor.top;
	const spaceBelow = window.innerHeight - anchor.bottom;
	const openUp = spaceAbove > spaceBelow;

	const style: React.CSSProperties = {
		position: "fixed",
		left: Math.max(8, Math.min(anchor.left, window.innerWidth - 280)),
		...(openUp
			? { bottom: window.innerHeight - anchor.top + 4 }
			: { top: anchor.bottom + 4 }),
		minWidth: 260,
		maxHeight: Math.min(420, (openUp ? spaceAbove : spaceBelow) - 8),
	};

	return createPortal(
		<div ref={ref} className="model-dropdown" style={style}>
			<div className="model-dropdown-header">Switch Model</div>

			{/* Pinned section */}
			{pinnedModels.length > 0 && (
				<>
					<div className="model-dropdown-section-title">Pinned</div>
					{pinnedModels.map(({ provider, model }) => (
						<ModelRow
							key={`${provider}/${model.modelId}`}
							provider={provider}
							model={model}
							isActive={model.modelId === currentModel}
							isPinned={true}
							onSelect={onSelect}
							onClose={onClose}
							onPinToggle={handlePinToggle}
						/>
					))}
				</>
			)}

			{/* Grouped sections */}
			{groupedModels.map(({ provider, models: providerModels }) => (
				<div key={provider}>
					<div className="model-dropdown-section-title">{provider}</div>
					{providerModels.map((model) => (
						<ModelRow
							key={`${provider}/${model.modelId}`}
							provider={provider}
							model={model}
							isActive={model.modelId === currentModel}
							isPinned={false}
							onSelect={onSelect}
							onClose={onClose}
							onPinToggle={handlePinToggle}
						/>
					))}
				</div>
			))}

			{models.length === 0 && (
				<div className="model-dropdown-empty">No models available</div>
			)}
		</div>,
		document.body,
	);
}

// ── Single Model Row ──────────────────────────────────────────

function ModelRow({
	provider,
	model,
	isActive,
	isPinned,
	onSelect,
	onClose,
	onPinToggle,
}: {
	provider: string;
	model: ModelOption;
	isActive: boolean;
	isPinned: boolean;
	onSelect: (provider: string, modelId: string) => void;
	onClose: () => void;
	onPinToggle: (e: React.MouseEvent, key: string) => void;
}) {
	const key = `${provider}/${model.modelId}`;
	return (
		<div className={`model-option-row ${isActive ? "active" : ""}`}>
			<button
				className="model-option-content"
				onClick={() => {
					console.log("[CodePi UI] select model:", provider, model.modelId);
					onSelect(provider, model.modelId);
					onClose();
				}}
			>
				<span className="model-option-name">
					{model.modelId.split("/").pop()}
				</span>
				<span className="model-option-provider">{provider}</span>
			</button>
			<button
				className={`model-option-pin ${isPinned ? "pinned" : ""}`}
				onClick={(e) => onPinToggle(e, key)}
				title={isPinned ? "Unpin model" : "Pin model"}
			>
				{isPinned ? "★" : "☆"}
			</button>
		</div>
	);
}

// ── Input Area ────────────────────────────────────────────────

export function InputArea({
	streaming,
	onSend,
	onAbort,
	modelName,
	availableModels,
	onModelSelect,
}: Props) {
	const [input, setInput] = useState("");
	const [modelOpen, setModelOpen] = useState(false);
	const [modelAnchor, setModelAnchor] = useState<DOMRect | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const badgeRef = useRef<HTMLButtonElement>(null);

	function handleSend() {
		const trimmed = input.trim();
		if (!trimmed || streaming) return;
		onSend(trimmed);
		setInput("");
		resizeTextarea();
	}

	function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
		if (e.key === "Escape" && streaming) onAbort();
	}

	function resizeTextarea() {
		const ta = textareaRef.current;
		if (ta) {
			ta.style.height = "auto";
			ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
		}
	}

	const openModelSelector = useCallback(() => {
		if (badgeRef.current) {
			setModelAnchor(badgeRef.current.getBoundingClientRect());
		}
		setModelOpen(true);
	}, []);

	const shortName = modelName?.split("/").pop() || "model";

	return (
		<div className="input-wrapper">
			<div className="chat-input-container">
				<div className="chat-input-row">
					<textarea
						ref={textareaRef}
						className="chat-input"
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							resizeTextarea();
						}}
						onKeyDown={handleKeyDown}
						placeholder={streaming ? "" : "Ask CodePi anything..."}
						rows={1}
						disabled={streaming}
					/>
					{streaming ? (
						<button className="stop-btn" onClick={onAbort} title="Stop">
							<span className="stop-icon" />
						</button>
					) : (
						<button className="send-btn" onClick={handleSend} disabled={!input.trim()} title="Send">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
						</button>
					)}
				</div>
				<div className="chat-input-toolbar">
					<button ref={badgeRef} className="model-badge-btn" onClick={openModelSelector}>
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
						<span className="model-badge-name">{shortName}</span>
					</button>
					<button className="chat-input-toolbar-btn right">
						{streaming ? "Generating..." : "Auto"}
					</button>
				</div>
			</div>

			{modelOpen && (
				<ModelDropdown
					models={availableModels}
					currentModel={modelName}
					onSelect={onModelSelect}
					onClose={() => setModelOpen(false)}
					anchor={modelAnchor}
				/>
			)}
		</div>
	);
}
